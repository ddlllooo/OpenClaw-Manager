import { useEffect, useRef, useState } from "react";
import { Bot, Paperclip, Send, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Empty, Select } from "@/components/shared";
import { request, readEvents } from "@/lib/api";
import { useDirty, useResource } from "@/lib/hooks";
import { instancePath as ip } from "@/lib/utils";
const histories = new Map();
export function clearChatHistory() {
  histories.clear();
}
const messageText = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n");
export default function Chat({ id }) {
  const agents = useResource(ip(id, "/agents"));
  const [agent, setAgent] = useState("main");
  const historyKey = `${id}:${agent}`;
  const [messages, setMessages] = useState(histories.get(historyKey) || []);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const abort = useRef(null);
  const lock = useRef(false);
  const end = useRef(null);
  useDirty(!!input || files.length > 0 || busy);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  useEffect(() => {
    setMessages(histories.get(historyKey) || []);
  }, [historyKey]);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [id],
  );
  useEffect(() => {
    if (
      agents.data?.agents?.length &&
      !agents.data.agents.some((a) => a.id === agent)
    )
      setAgent(agents.data.agents[0].id);
  }, [agents.data, agent]);
  const attach = async (event) => {
    const selected = [...event.target.files];
    event.target.value = "";
    if (files.length + selected.length > 4)
      return toast.error("每次最多 4 个附件");
    if (
      selected.some((file) => file.size > 5 * 1024 ** 2) ||
      [...files, ...selected].reduce(
        (sum, file) => sum + (file.size || file.bytes || 0),
        0,
      ) >
        20 * 1024 ** 2
    )
      return toast.error("每个附件最多 5MB，总计最多 20MB");
    setReading(true);
    try {
      const attachments = await Promise.all(
        selected.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error("附件读取失败"));
              reader.onload = () =>
                resolve({
                  fileName: file.name,
                  type: file.type.startsWith("image/") ? "image" : "file",
                  mimeType: file.type || "application/octet-stream",
                  content: reader.result.split(",")[1],
                  bytes: file.size,
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      setFiles((previous) => [...previous, ...attachments]);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setReading(false);
    }
  };
  const send = async (e) => {
    e?.preventDefault();
    if (lock.current || reading || (!input.trim() && !files.length)) return;
    lock.current = true;
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    const pending = { role: "assistant", text: "正在准备…" };
    const transcript = [
      ...messages,
      {
        role: "user",
        text:
          input +
          (files.length
            ? `\n附件：${files.map((file) => file.fileName).join("、")}`
            : ""),
      },
      pending,
    ];
    const repaint = () => {
      histories.set(historyKey, transcript);
      setMessages([...transcript]);
    };
    const attachments = files;
    const prompt = input;
    setInput("");
    setFiles([]);
    repaint();
    let accumulated = "",
      terminal = false;
    try {
      const response = await request(ip(id, "/chat/stream"), {
        method: "POST",
        body: { message: prompt, attachments, agentId: agent },
        signal: controller.signal,
        raw: true,
      });
      await readEvents(response, (event) => {
        if (event.kind === "error") throw new Error(event.error);
        if (event.kind === "chat") {
          const data = event.data;
          if (data.state === "error")
            throw new Error(
              data.errorMessage || data.error?.message || "模型执行失败",
            );
          if (data.state === "delta") {
            accumulated =
              messageText(data.message) ||
              (data.replace
                ? data.deltaText || ""
                : accumulated + (data.deltaText || ""));
            pending.text = accumulated || "模型处理中…";
          }
          if (data.state === "final" || data.state === "aborted") {
            terminal = true;
            pending.text =
              messageText(data.message) ||
              accumulated ||
              (data.state === "aborted"
                ? "已停止生成。"
                : "执行已完成，无文本回复。");
          }
        }
        repaint();
      });
      if (!terminal) throw new Error("连接已结束，请到会话页核对执行结果");
    } catch (error) {
      pending.text =
        error.name === "AbortError"
          ? "已断开，请在会话页检查执行结果。"
          : `出错了：${error.message}`;
      repaint();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bot className="size-4 text-brand-ink" />
          <h2 className="text-sm font-medium">对话</h2>
        </div>
        <Select
          className="w-40"
          aria-label="选择对话 Agent"
          disabled={busy}
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          {(agents.data?.agents || [{ id: "main", name: "main" }]).map((a) => (
            <option value={a.id} key={a.id}>
              {a.name || a.id}
            </option>
          ))}
        </Select>
      </div>
      <div
        className="h-[420px] overflow-y-auto rounded-xl border border-border bg-card p-5"
        role="log"
        aria-live="polite"
      >
        {!messages.length && (
          <Empty
            title="暂无对话"
            description="提出问题、上传文件，或交给 Agent 一项工作。"
          />
        )}
        {messages.map((message, i) => (
          <div
            className={`mb-5 max-w-[90%] rounded-xl p-4 ${message.role === "user" ? "ml-auto border border-brand/20 bg-brand/5" : "bg-secondary/60"}`}
            key={i}
          >
            <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
              {message.role === "user" ? "你" : agent}
            </p>
            <div className="whitespace-pre-wrap break-words text-sm leading-7">
              {message.text}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        onSubmit={send}
        className="mt-4 rounded-xl border border-border bg-card p-3"
      >
        <Textarea
          aria-label="消息内容"
          placeholder="输入消息…"
          className="min-h-20 resize-none border-0 bg-transparent focus-visible:ring-0"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send(e);
          }}
        />
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((file, i) => (
            <button
              type="button"
              key={i}
              className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
              onClick={() => setFiles(files.filter((_, index) => index !== i))}
            >
              {file.fileName}
              <X className="size-3" />
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <label
            className={`rounded-md p-2 text-muted-foreground hover:bg-accent ${busy || reading ? "pointer-events-none opacity-40" : "cursor-pointer"}`}
          >
            <Paperclip className="size-4" />
            <span className="sr-only">上传附件</span>
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={busy || reading}
              accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.docx,.xlsx"
              onChange={attach}
            />
          </label>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            Ctrl / ⌘ + Enter 发送
          </span>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await request(ip(id, "/chat/abort"), {
                    method: "POST",
                    body: {},
                  });
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            >
              <Square />
              停止生成
            </Button>
          ) : (
            <Button
              disabled={reading || (!input.trim() && !files.length)}
              size="sm"
            >
              <Send />
              {reading ? "读取附件…" : "发送"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
