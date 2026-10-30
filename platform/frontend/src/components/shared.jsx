import { cloneElement, useId, useState } from "react";
import { Loader2, AlertCircle, PackageOpen } from "lucide-react";
import { Button } from "./ui/button";
import { Input, Textarea } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { useAction, useDirty } from "@/lib/hooks";

export function Loading() {
  return (
    <div
      className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-4 animate-spin" />
      正在加载…
    </div>
  );
}
export function ErrorNotice({ children, retry }) {
  return (
    <div
      role="alert"
      className="my-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"
    >
      <AlertCircle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          重试
        </Button>
      )}
    </div>
  );
}
export function Resource({ resource, children }) {
  return (
    <>
      {resource.error && (
        <ErrorNotice retry={resource.reload}>{resource.error}</ErrorNotice>
      )}
      {resource.loading ? (
        <Loading />
      ) : resource.data ? (
        children(resource.data)
      ) : null}
    </>
  );
}
export function Empty({ title = "暂无内容", description, action }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-4 px-5 text-center">
      <div className="rounded-xl border border-border bg-secondary p-4">
        <PackageOpen className="size-6 text-muted-foreground" />
      </div>
      <h3 className="text-base font-medium">{title}</h3>
      {description && (
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}
export function Field({ label, children, hint }) {
  const generatedId = useId();
  const id = children.props.id || generatedId;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs font-medium text-foreground/80">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        ...(hint ? { "aria-describedby": `${id}-hint` } : {}),
      })}
      {hint && (
        <span
          id={`${id}-hint`}
          className="font-normal leading-5 text-muted-foreground"
        >
          {hint}
        </span>
      )}
    </div>
  );
}
export function Select({ className = "", children, ...props }) {
  return (
    <select
      className={`h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}
export function Check({ label, ...props }) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input type="checkbox" className="size-4 accent-brand" {...props} />
      {label}
    </label>
  );
}
export function Status({ state }) {
  const running = state === "running" || state === "connected";
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] ${running ? "border-success/20 bg-success/8 text-success" : "border-border bg-secondary text-muted-foreground"}`}
    >
      <span
        className={`size-1.5 rounded-full ${running ? "bg-success" : "bg-inactive"}`}
      />
      {{
        running: "运行中",
        exited: "已停止",
        "not-created": "待创建",
        connected: "已连接",
        disconnected: "已断开",
        connecting: "连接中",
        unknown: "状态未知",
        paused: "已暂停",
      }[state] || state}
    </span>
  );
}
export function JsonView({ value }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-background p-4 font-mono text-xs leading-6 text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
export function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">
          {eyebrow}
        </p>
        <h1 className="text-3xl font-semibold tracking-[-.04em] sm:text-4xl">
          {title}
        </h1>
        {description && (
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

// Declarative form shared by creation, resource settings, model and SSH editors.
export function FormDialog({
  title,
  description,
  fields,
  initial = {},
  submit,
  onClose,
  submitLabel = "保存",
  children,
}) {
  const [values, setValues] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  useDirty(dirty);
  const close = () => {
    if (!busy && (!dirty || window.confirm("放弃尚未保存的修改？"))) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {description || "填写设置后保存。"}
        </DialogDescription>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await submit(values);
              setDirty(false);
              onClose();
            }, "已保存");
          }}
        >
          <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <div
                key={field.key}
                className={field.wide ? "sm:col-span-2" : ""}
              >
                {field.type === "checkbox" ? (
                  <Check
                    label={field.label}
                    checked={!!values[field.key]}
                    onChange={(e) => {
                      setValues({ ...values, [field.key]: e.target.checked });
                      setDirty(true);
                    }}
                  />
                ) : (
                  <Field label={field.label} hint={field.hint}>
                    {field.options ? (
                      <Select
                        value={values[field.key] ?? ""}
                        onChange={(e) => {
                          setValues({ ...values, [field.key]: e.target.value });
                          setDirty(true);
                        }}
                      >
                        {field.options.map((option) => (
                          <option
                            key={option.value ?? option}
                            value={option.value ?? option}
                          >
                            {option.label ?? option}
                          </option>
                        ))}
                      </Select>
                    ) : field.type === "textarea" ? (
                      <Textarea
                        required={field.required}
                        value={values[field.key] ?? ""}
                        onChange={(e) => {
                          setValues({ ...values, [field.key]: e.target.value });
                          setDirty(true);
                        }}
                      />
                    ) : (
                      <Input
                        type={field.type || "text"}
                        required={field.required}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        autoComplete={
                          field.type === "password" ? "new-password" : "off"
                        }
                        placeholder={field.placeholder}
                        value={values[field.key] ?? ""}
                        onChange={(e) => {
                          setValues({
                            ...values,
                            [field.key]:
                              field.type === "number" && e.target.value !== ""
                                ? Number(e.target.value)
                                : e.target.value,
                          });
                          setDirty(true);
                        }}
                      />
                    )}
                  </Field>
                )}
              </div>
            ))}
          </fieldset>
          {children?.(values, setValues)}
          <div className="flex justify-end gap-2 border-t border-border pt-5">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={close}
            >
              取消
            </Button>
            <Button disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? "正在处理…" : submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
