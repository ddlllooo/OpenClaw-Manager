import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormDialog, Resource, ErrorNotice } from "@/components/shared";
import { useAction, useResource } from "@/lib/hooks";
import { request } from "@/lib/api";
import { bytes, date, instancePath as ip } from "@/lib/utils";

export default function Storage({ id, reloadInstance }) {
  const resource = useResource(ip(id, "/storage"), 5000);
  const backups = useResource(ip(id, "/storage/backups"));
  const capabilities = useResource(ip(id, "/storage/capabilities"));
  const [dialog, setDialog] = useState(null);
  const [preview, setPreview] = useState(null);
  const [checks, setChecks] = useState(null);
  const { busy, run } = useAction();
  const mutate = (suffix, body = {}, method = "POST") => request(ip(id, "/storage" + suffix), { method, body });
  const refresh = async () => { await Promise.all([resource.reload(), backups.reload(), capabilities.reload(), reloadInstance()]); };
  const act = (fn, message) => run(async () => { const result = await fn(); await refresh(); return result; }, message);
  return (
    <Resource resource={resource}>
      {(data) => (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium">存储与备份</h2>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog({ type: "policy" })} disabled={busy}>容量策略</Button>
              <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>刷新用量</Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">平台每 5 秒检查空间和文件数；提前停止接单、等待任务收尾，再保护停机。软保护无法保证瞬时写入不超过额度；硬配额仅在宿主内核读回验证后标记生效。</p>
          {data.maintenanceWarning && <p role="status" className="text-xs text-warning">{data.maintenanceWarning}</p>}
          <Card>
            <CardHeader><CardTitle>宿主硬配额能力</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-xs">
              <Resource resource={capabilities}>{cap => <div className="space-y-2"><p>{cap.supported ? "支持宿主硬配额；仍需停机应用并验证" : "此宿主或实例暂不支持硬配额"}</p>{cap.reason && <p className="text-warning">{cap.reason}</p>}<p>{data.hardQuota ? "当前状态：硬配额已验证并生效" : data.policy.mode === "hard" ? "当前状态：硬配额未验证，禁止启动" : "当前状态：软保护"}</p></div>}</Resource>
              {data.quotaError && <p className="text-destructive">{data.quotaError}</p>}
              {data.quota && <p className="font-mono">空间 {bytes(data.quota.usedBytes)} / {bytes(data.quota.hardBytes)}{data.quota.inodeQuota === false ? ` · APFS 卷容量配额，不提供文件数硬限制；${data.quota.automaticRecovery ? '宿主重启后校验并恢复原先运行的实例，手动停止或存储保护不自动恢复' : '宿主重启后需通过挂载校验并手动启动'}` : ` · 文件及目录 ${data.quota.usedInodes} / ${data.quota.hardInodes}`}</p>}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => capabilities.reload()}>重新探测宿主</Button>
              {data.hardQuota && <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => mutate("/quota/verify"), "硬配额覆盖范围和内核上限校验通过")}>验证实际硬配额</Button>}
              <p className="text-muted-foreground">硬配额覆盖当前实例目录，独立执行卷暂不支持。镜像、容器可写层和备份不属于此额度。不会自动格式化或重新挂载宿主磁盘。</p>
            </CardContent>
          </Card>
          {data.drain && <p role="status" className="rounded-lg border border-warning/30 p-4 text-xs">保护阶段：{({requested:"停止接单",draining:"等待已接收任务收尾",stopping:"正在保护停机",stopped:"已保护停机"})[data.drain.phase] || data.drain.phase}。{data.drain.fallbackReason || data.drain.stopReason || "新对话、上传、插件操作和定时任务启动已被平台拒绝。"}{data.drain.interruptedPossible ? " 任务可能未完成或未保存，请检查会话后再恢复，避免重复提交。" : ""}</p>}
          {(data.reason || data.blocked || data.recoveryPending) && (
            <ErrorNotice>
              {data.reason || data.blocked?.reason || "存在未完成的数据恢复"}。数据保留；请停机、清理或扩容，并将空间及文件数降至告警阈值以下，再手动解除保护和启动。
              <Button variant="outline" size="sm" disabled={busy || !!data.reason || data.recoveryPending || (data.percent !== null && data.percent >= data.policy.warnPercent) || (data.drain && data.drain.phase !== "stopped")} onClick={() => act(() => mutate("/release"), "保护已解除")}>解除保护</Button>
              {data.recoveryPending && <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog({type:"rollback"})}>回滚未完成恢复</Button>}
            </ErrorNotice>
          )}
          {data.status === "warning" && <p role="status" className="text-sm text-warning">数据用量已达到告警阈值，请及时清理或扩容。</p>}
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["实例目录占用", bytes(data.bytes), `${data.fileCount} 个文件 · ${data.percent === null ? "未设置额度" : data.percent.toFixed(1) + "%"}`],
              ["保护额度", data.policy.limitGiB ? `${data.policy.limitGiB} GiB` : "未开启", `${data.policy.warnPercent}% 告警 / ${data.policy.admissionPercent ?? 90}% 停接 / ${data.policy.stopPercent}% 停机`],
              ["所在文件系统可用", bytes(data.disk.available), `预留 ${data.policy.minFreeGiB} GiB · 备份需额外空间`],
            ].map(([title,value,note]) => <Card key={title}><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><p className="font-mono text-xl">{value}</p><p className="mt-2 text-xs text-muted-foreground">{note}</p></CardContent></Card>)}
          </div>
          <Card>
            <CardHeader><CardTitle>数据卷挂载</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {data.mounts.map(m => <div key={m.folder} className="rounded-lg border border-border p-4 text-xs"><div className="mb-2 flex justify-between gap-3"><strong>{m.folder}</strong><span>{bytes(m.bytes)}</span></div><p className="break-all font-mono">{m.source}</p><p className="mt-1 break-all font-mono text-muted-foreground">→ {m.target}</p></div>)}
              <p className="text-xs text-muted-foreground">{data.coverage}</p>
              <p className="text-xs text-muted-foreground">挂载位置由平台固定管理。迁移宿主路径需停机、备份、离线复制校验后重建容器；此处不允许添加任意宿主目录。</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>数据清理</CardTitle><p className="text-xs text-muted-foreground">仅清理 openclaw/logs 下超过 7 天的轮转日志。不会选择活动日志、会话、记忆、工作文件或数据库。执行前请停止实例。</p></CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => setPreview(await request(ip(id,"/storage/cleanup"))))}>预览可清理文件</Button>
              {preview && <div className="space-y-3 text-xs"><p>可清理 {preview.candidates.length} 个文件，预计释放 {bytes(preview.bytes)}。</p><ul className="max-h-48 space-y-2 overflow-auto">{preview.candidates.map(r=><li key={r.path} className="break-all font-mono">{r.path} · {bytes(r.bytes)}</li>)}</ul><Button variant="destructive" size="sm" disabled={busy || !preview.candidates.length} onClick={() => setDialog({type:"cleanup"})}>清理预览中的文件</Button></div>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>实例加密备份</CardTitle><p className="text-xs text-muted-foreground">普通实例停机后备份三个挂载目录，发布前验证文件哈希和加密完整性。恢复会覆盖这些目录，先自动备份当前数据，并保持停机。独立执行卷及隔离实例请使用平台全量备份。</p></CardHeader>
            <CardContent className="space-y-4">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => mutate("/backups"),"加密备份已完成并校验")}>创建停机备份</Button>
              <Resource resource={backups}>{({backups:rows}) => rows.length ? <div className="space-y-3">{rows.map(b=><div key={b.name} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs"><div><p className="break-all font-mono">{b.name}</p><p className="mt-1 text-muted-foreground">{date(b.createdAt)} · {bytes(b.bytes)}</p></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => mutate(`/backups/${encodeURIComponent(b.name)}/verify`),"备份完整性校验通过")}>校验</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog({type:"restore",name:b.name})}>恢复</Button><Button variant="ghost" size="sm" disabled={busy || rows.length < 2} onClick={() => setDialog({type:"deleteBackup",name:b.name})}>删除备份</Button></div></div>)}</div> : <p className="text-xs text-muted-foreground">暂无实例备份。平台全量备份可在系统页查看。</p>}</Resource>
              <p className="text-xs text-muted-foreground">备份保存在实例目录之外，不计入实例额度。请独立保管备份密钥，并定期将备份转存其他磁盘；本入口的备份不会自动过期。</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>数据检查与修复</CardTitle><p className="text-xs text-muted-foreground">检查挂载目录和配置历史。配置损坏可恢复历史版本；数据库或业务数据损坏需校验并恢复备份。</p></CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => setChecks(await request(ip(id,"/storage/diagnostics"))))}>检查数据</Button>
              {checks && <div className="space-y-2 text-xs">{checks.checks.map(c=><div key={c.name} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3"><span>{c.name} · {c.ok ? "可用" : c.missing ? "不存在" : "异常"}</span>{c.ok && /\.(last-good|bak\.\d)$/.test(c.name) && <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog({type:"repair",source:c.name})}>恢复此配置</Button>}</div>)}<p className="text-muted-foreground">{checks.hint}</p></div>}
            </CardContent>
          </Card>
          {dialog?.type === "policy" && <FormDialog title="实例容量策略" description="硬配额需先停止实例；应用失败或宿主读回不符会阻止启动。达到停止接单阈值后进入有时限的收尾流程，突发写满仍可能中断任务。已触发的保护需手动解除。" initial={{...data.policy,mode:data.policy.mode || "soft",admissionPercent:data.policy.admissionPercent ?? 90,drainSeconds:data.policy.drainSeconds ?? 30,hardInodes:data.policy.hardInodes ?? 100000}} fields={[
            {key:"mode",label:"保护模式",options:[{value:"soft",label:"软保护（监测与停机）"},{value:"hard",label:"硬配额（需宿主支持并验证）"}]},
            {key:"limitGiB",label:"实例容量额度（GiB）",type:"number",min:0,step:0.1,required:true},
            {key:"minFreeGiB",label:"文件系统保留空间（GiB）",type:"number",min:0,step:0.1,required:true},
            {key:"warnPercent",label:"告警比例（%）",type:"number",min:1,max:99,required:true},
            {key:"admissionPercent",label:"停止接单比例（%）",type:"number",min:2,max:98,required:true},
            {key:"drainSeconds",label:"最长收尾等待（秒）",type:"number",min:1,max:30,required:true},
            {key:"hardInodes",label:"XFS 文件数硬上限（APFS 不提供此限制）",type:"number",min:100,required:true},
            {key:"stopPercent",label:"停机比例（%）",type:"number",min:2,max:100,required:true},
          ]} onClose={() => setDialog(null)} submit={async v => {await mutate("/policy",v,"PATCH");await refresh();}} />}
          {dialog && dialog.type !== "policy" && <FormDialog title={{cleanup:"确认清理轮转日志",restore:"确认覆盖恢复实例数据",repair:"确认恢复历史配置",rollback:"回滚未完成的数据恢复",deleteBackup:"确认删除备份"}[dialog.type]} description={dialog.type === "restore" ? `恢复 ${dialog.name}。会先创建当前数据的加密备份，再替换三个挂载目录。请先停止实例，并确保有足够临时空间。` : dialog.type === "deleteBackup" ? `删除 ${dialog.name}。至少保留一份通过校验的其他备份。` : "请先停止实例。操作结束后保持停止，由你检查并手动启动。"} fields={[]} submitLabel="确认执行" onClose={() => setDialog(null)} submit={async () => {
            if(dialog.type === "cleanup") { await mutate("/cleanup",{revision:preview.revision});setPreview(null); }
            if(dialog.type === "deleteBackup") await mutate(`/backups/${encodeURIComponent(dialog.name)}`,{},"DELETE");
            if(dialog.type === "restore") await mutate(`/backups/${encodeURIComponent(dialog.name)}/restore`);
            if(dialog.type === "repair") await mutate("/repair-config",{source:dialog.source});
            if(dialog.type === "rollback") await mutate("/rollback");
            setChecks(null);await refresh();
          }} />}
        </div>
      )}
    </Resource>
  );
}
