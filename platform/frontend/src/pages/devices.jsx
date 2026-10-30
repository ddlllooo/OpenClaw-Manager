import { useRef, useState } from "react";
import { ArrowUpRight, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Check,
  Empty,
  Field,
  PageHeading,
  Resource,
  Select,
  Status,
} from "@/components/shared";
import { canNavigate, useAction, useDirty, useResource } from "@/lib/hooks";
import { request } from "@/lib/api";
import { bytes } from "@/lib/utils";

export default function DevicesPage() {
  const resource = useResource("/api/connections", 5000);
  const [edit, setEdit] = useState(null);
  const images = useResource("/api/connections/local-images");
  const [image, setImage] = useState("");
  const [target, setTarget] = useState("");
  const { busy, run } = useAction();
  const action = (id, suffix, method = "POST", body = {}) =>
    run(async () => {
      await request(`/api/connections/${encodeURIComponent(id)}${suffix}`, {
        method,
        body,
      });
      resource.reload();
    }, "设备操作已提交");
  return (
    <div className="page-enter space-y-6">
      <PageHeading
        title="部署设备"

        action={
          <Button onClick={() => setEdit({})}>
            <Plus />
            连接远程设备
          </Button>
        }
      />
      <Resource resource={resource}>
        {(data) =>
          !data.connections.length ? (
            <Card>
              <Empty
                title="连接第一台远程设备"
                description="添加 SSH 连接后，可自动部署 Manager，或接入已经运行的管理服务。"
                action={
                  <Button variant="outline" onClick={() => setEdit({})}>
                    添加 SSH 设备
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.connections.map((row) => (
                <Card key={row.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle>
                        {row.name || `${row.username}@${row.host}`}
                      </CardTitle>
                      <Status state={row.status} />
                    </div>
                    <p className="pt-2 font-mono text-[11px] text-muted-foreground">
                      {row.username}@{row.host}:{row.port} · Manager :
                      {row.remotePort}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <p className="mb-2 text-xs text-muted-foreground">
                      {row.notes}
                    </p>
                    <p
                      className={`mb-4 text-xs leading-6 ${row.error ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {row.error || row.stage}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {row.url && (
                        <Button
                          size="sm"
                          onClick={() => {
                            if (canNavigate()) location.assign(row.url);
                          }}
                        >
                          切换到此设备
                          <ArrowUpRight />
                        </Button>
                      )}
                      {row.status === "ssh-ready" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || row.transfer?.status === "running"}
                          onClick={() => action(row.id, "/deploy-offline")}
                        >
                          离线启动 Manager
                        </Button>
                      )}
                      {["connected", "connecting", "ssh-ready"].includes(
                        row.status,
                      ) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => action(row.id, "", "DELETE")}
                        >
                          断开
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => action(row.id, "/reconnect")}
                        >
                          重新连接
                        </Button>
                      )}
                      {row.saved && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEdit(row)}
                          >
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              action(row.id, "", "PATCH", {
                                autoReconnect: !row.autoReconnect,
                              })
                            }
                          >
                            {row.autoReconnect ? "关闭" : "开启"}自动重连
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={
                              busy || row.transfer?.status === "running"
                            }
                            onClick={() => {
                              if (
                                confirm(
                                  "移除设备及保存的认证信息？远程实例将继续运行。",
                                )
                              )
                                action(row.id, "/saved", "DELETE");
                            }}
                          >
                            移除
                          </Button>
                        </>
                      )}
                    </div>
                    {row.transfer && (
                      <div className="mt-5 rounded-lg border border-border bg-background p-4">
                        <p className="mb-2 break-all text-xs">
                          {row.transfer.image}
                        </p>
                        <p
                          role="status"
                          className="text-xs leading-6 text-muted-foreground"
                        >
                          {row.transfer.stage} · {bytes(row.transfer.bytesSent)}
                          {row.transfer.error && ` · ${row.transfer.error}`}
                        </p>
                        {row.transfer.status === "running" && (
                          <Button
                            className="mt-2"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => action(row.id, "/images/cancel")}
                          >
                            取消传输
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )
        }
      </Resource>
      <Card>
        <CardHeader>
          <CardTitle>离线镜像传输</CardTitle>
          <p className="text-xs leading-6 text-muted-foreground">
            将本机 Docker 中的镜像通过 SSH 流式导入目标设备；本机需要 Docker。
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid items-end gap-4 md:grid-cols-[1fr_1fr_auto]">
            <Field label="本机镜像">
              <Select value={image} onChange={(e) => setImage(e.target.value)}>
                <option value="">选择本机镜像</option>
                {images.data?.images.map((row) => (
                  <option value={row.image} key={row.image}>
                    {row.image} · {bytes(row.size)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="目标设备">
              <Select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">选择目标设备</option>
                {resource.data?.connections
                  .filter((row) =>
                    ["connected", "ssh-ready"].includes(row.status),
                  )
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name || row.host}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              disabled={busy || !target || !image}
              onClick={() => {
                const row = images.data?.images.find((i) => i.image === image);
                if (row)
                  action(target, "/images/transfer", "POST", {
                    image: row.image,
                    imageId: row.imageId,
                  });
              }}
            >
              <Upload />
              传输镜像
            </Button>
          </div>
          {images.error && (
            <p className="mt-3 text-xs text-muted-foreground">
              无法读取本机镜像：{images.error}
            </p>
          )}
          <Button
            className="mt-3"
            variant="ghost"
            size="sm"
            onClick={images.reload}
          >
            刷新镜像列表
          </Button>
        </CardContent>
      </Card>
      {edit && (
        <SshEditor
          row={edit}
          onClose={() => setEdit(null)}
          reload={resource.reload}
        />
      )}
    </div>
  );
}
function SshEditor({ row, onClose, reload }) {
  const [values, setValues] = useState({
    name: row.name || "",
    notes: row.notes || "",
    host: row.host || "",
    port: row.port || 22,
    username: row.username || "",
    remotePort: row.remotePort || 18080,
    auth: row.auth || "password",
    mode: row.id ? (row.sshOnly ? "ssh-only" : "existing") : "deploy",
    password: "",
    privateKey: "",
    passphrase: "",
    save: row.saved ?? true,
    autoReconnect: row.autoReconnect ?? true,
  });
  const [fingerprint, setFingerprint] = useState(row.fingerprint || "");
  const [verified, setVerified] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [probedTarget, setProbedTarget] = useState(
    row.host ? `${row.host}:${row.port}` : "",
  );
  const { busy, run } = useAction();
  const target = `${values.host.trim()}:${values.port}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  const valid = fingerprint && verified && probedTarget === target;
  const set = (key, value) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
    if (["host", "port"].includes(key)) {
      setFingerprint("");
      setVerified(false);
    }
  };
  useDirty(dirty);
  const close = () => {
    if (!busy && (!dirty || confirm("放弃尚未保存的 SSH 设置？"))) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>{row.id ? "编辑远程设备" : "连接远程设备"}</DialogTitle>
        <DialogDescription>
          填写 SSH 认证信息，并通过目标设备或可信渠道核对主机指纹。
        </DialogDescription>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            run(async () => {
              const payload = {
                ...values,
                port: Number(values.port),
                remotePort: Number(values.remotePort),
                fingerprint,
                sshOnly: values.mode === "ssh-only",
                deploy: values.mode === "deploy",
                autoReconnect: values.save && values.autoReconnect,
              };
              delete payload.mode;
              if (!payload.password) delete payload.password;
              if (!payload.privateKey) delete payload.privateKey;
              if (!payload.passphrase) delete payload.passphrase;
              await request(
                `/api/connections${row.id ? `/${encodeURIComponent(row.id)}` : ""}`,
                { method: row.id ? "PATCH" : "POST", body: payload },
              );
              setDirty(false);
              reload();
              onClose();
            }, "设备设置已提交");
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["name", "设备名称"],
              ["host", "主机地址"],
              ["port", "SSH 端口"],
              ["username", "用户名"],
              ["remotePort", "Manager 端口"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  required={["host", "username", "port", "remotePort"].includes(
                    key,
                  )}
                  type={
                    ["port", "remotePort"].includes(key) ? "number" : "text"
                  }
                  min={key.toLowerCase().includes("port") ? 1 : undefined}
                  max={key.toLowerCase().includes("port") ? 65535 : undefined}
                  value={values[key]}
                  onChange={(e) => set(key, e.target.value)}
                />
              </Field>
            ))}
            <Field label="部署方式">
              <Select
                value={values.mode}
                onChange={(e) => set("mode", e.target.value)}
              >
                <option value="deploy">自动部署 Manager</option>
                <option value="existing">连接已有 Manager</option>
                <option value="ssh-only">仅连接 SSH（离线准备）</option>
              </Select>
            </Field>
            <Field label="认证方式">
              <Select
                value={values.auth}
                onChange={(e) => {
                  set("auth", e.target.value);
                  set("password", "");
                  set("privateKey", "");
                }}
              >
                <option value="password">密码</option>
                <option value="key">私钥文件</option>
                <option value="agent">SSH Agent</option>
              </Select>
            </Field>
            {values.auth === "password" && (
              <Field
                label="SSH 密码"
                hint={row.id ? "留空保留已保存的密码。" : undefined}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={values.password}
                  required={
                    !row.id ||
                    target !== `${row.host}:${row.port}` ||
                    row.auth !== values.auth
                  }
                  onChange={(e) => set("password", e.target.value)}
                />
              </Field>
            )}
            {values.auth === "key" && (
              <>
                <Field
                  label="私钥文件"
                  hint={
                    values.privateKey
                      ? "已读取私钥。"
                      : row.id
                        ? "不选择文件则保留已保存的私钥。"
                        : "OpenSSH / PEM 文件，最大 64 KB。"
                  }
                >
                  <Input
                    type="file"
                    onChange={async (e) => {
                      const file = e.target.files[0];
                      if (!file) return;
                      if (file.size > 65536)
                        return toast.error("私钥文件不能超过 64KB");
                      try {
                        set("privateKey", await file.text());
                      } catch {
                        toast.error("无法读取私钥文件");
                      }
                    }}
                  />
                </Field>
                <Field label="私钥口令（可选）">
                  <Input
                    type="password"
                    value={values.passphrase}
                    onChange={(e) => set("passphrase", e.target.value)}
                  />
                </Field>
              </>
            )}
            <div className="sm:col-span-2">
              <Field label="备注">
                <Textarea
                  value={values.notes}
                  onChange={(e) => set("notes", e.target.value)}
                />
              </Field>
            </div>
          </div>
          <div className="space-y-3 rounded-lg border border-border p-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !values.host}
              onClick={() =>
                run(async () => {
                  const expected = target;
                  const data = await request("/api/connections/probe", {
                    method: "POST",
                    body: { host: values.host, port: Number(values.port) },
                  });
                  if (targetRef.current !== expected) return;
                  setFingerprint(data.fingerprint);
                  setProbedTarget(expected);
                  setVerified(false);
                })
              }
            >
              获取主机指纹
            </Button>
            {fingerprint && (
              <code className="block break-all text-xs text-brand-ink">
                {fingerprint}
              </code>
            )}
            <Check
              label="已通过可信渠道核对，指纹一致"
              checked={verified}
              disabled={!fingerprint || probedTarget !== target}
              onChange={(e) => setVerified(e.target.checked)}
            />
          </div>
          <Check
            label="加密保存设备认证信息"
            checked={values.save}
            disabled={!!row.id}
            onChange={(e) => set("save", e.target.checked)}
          />
          <Check
            label="连接中断后自动重连"
            checked={values.autoReconnect}
            disabled={!values.save}
            onChange={(e) => set("autoReconnect", e.target.checked)}
          />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={close}
            >
              取消
            </Button>
            <Button disabled={busy || !valid}>
              {busy ? "正在处理…" : row.id ? "保存更改" : "连接设备"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
