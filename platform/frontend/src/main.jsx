import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { authenticate, logout } from "@/lib/api";
import { clearChatHistory } from "@/pages/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorNotice, Field, Loading } from "@/components/shared";
import App from "./App";
import "./styles.css";

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div className="mx-auto max-w-xl p-8">
        <ErrorNotice>
          界面加载失败，请重新加载。未保存的内容可能需要重新输入。
        </ErrorNotice>
        <Button onClick={() => location.reload()}>重新加载</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Session() {
  const [status, setStatus] = useState("loading");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const bootstrap = new URLSearchParams(location.hash.slice(1)).get(
      "manager_token",
    );
    if (bootstrap)
      history.replaceState(null, "", location.pathname + location.search);
    authenticate(bootstrap, abort.signal)
      .then(() => setStatus("ready"))
      .catch((e) => {
        if (e.name !== "AbortError") {
          setStatus("auth");
          if (e.status !== 401) setError(e.message);
        }
      });
    const expired = () => {
      setStatus("auth");
      setError("管理会话已过期，请重新登录。");
    };
    window.addEventListener("manager:unauthorized", expired);
    return () => {
      abort.abort();
      window.removeEventListener("manager:unauthorized", expired);
    };
  }, []);
  if (status === "loading")
    return (
      <div className="grid min-h-screen place-items-center">
        <Loading />
      </div>
    );
  if (status === "ready")
    return (
      <App
        onLogout={async () => {
          await logout();
          clearChatHistory();
          setToken("");
          setError("");
          setStatus("auth");
        }}
      />
    );
  return (
    <div className="grid min-h-screen place-items-center p-6 hero-glow">
      <form
        className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-8"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await authenticate(token);
            setToken("");
            setStatus("ready");
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-8">
          <div className="mb-5 text-xs tracking-widest text-muted-foreground">
            OPENCLAW MANAGER
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            进入工作空间
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            使用管理凭证连接你的部署环境。
          </p>
        </div>
        <Field label="管理凭证">
          <Input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <Button className="w-full" disabled={busy}>
          {busy ? "正在连接…" : "连接工作空间"}
        </Button>
      </form>
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <Session />
    <Toaster theme="dark" richColors closeButton position="bottom-right" />
  </ErrorBoundary>,
);
