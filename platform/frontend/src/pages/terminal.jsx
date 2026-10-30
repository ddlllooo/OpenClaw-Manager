import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
export default function ContainerTerminal({ id }) {
  const element = useRef(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState("连接中…");
  useEffect(() => {
    let disposed = false,
      ws,
      retry,
      attempts = 0;
    const palette = getComputedStyle(document.documentElement);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Consolas, monospace",
      theme: {
        background: palette.getPropertyValue("--background").trim(),
        foreground: palette.getPropertyValue("--foreground").trim(),
        cursor: palette.getPropertyValue("--foreground").trim(),
        selectionBackground: "#5e6ad244",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current);
    const resize = () => {
      try {
        fit.fit();
        if (ws?.readyState === 1)
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
      } catch {}
    };
    const connect = () => {
      if (disposed) return;
      setStatus("连接中…");
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/instances/${encodeURIComponent(id)}/terminal`,
      );
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        setStatus("已连接");
        resize();
        term.focus();
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string")
          term.write(new Uint8Array(event.data));
        else {
          const message = JSON.parse(event.data);
          if (message.type === "error") {
            setStatus(message.message);
            term.writeln(`\r\n${message.message}`);
          }
          if (message.type === "exit") {
            attempts = 5;
            setStatus(`Shell 已退出 (${message.code})，可手动重连。`);
          }
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        if (++attempts <= 3) {
          setStatus("连接已断开，3 秒后重试…");
          retry = setTimeout(connect, 3000);
        } else setStatus("连接已断开，请检查实例状态并重新连接。");
      };
      ws.onerror = () => {};
    };
    const input = term.onData((data) => {
      if (ws?.readyState === 1) ws.send(new TextEncoder().encode(data));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    resize();
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      observer.disconnect();
      input.dispose();
      ws?.close();
      term.dispose();
    };
  }, [id, generation]);
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setGeneration((g) => g + 1)}
        >
          重新连接
        </Button>
      </div>
      <div
        ref={element}
        aria-label="容器交互终端"
        className="h-[480px] rounded-lg border border-border bg-console p-3"
      />
    </div>
  );
}
