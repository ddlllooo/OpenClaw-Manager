import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./api";
import { toast } from "sonner";

export function useResource(path, interval = 0) {
  const [result, setResult] = useState({
    data: null,
    error: null,
    loading: true,
  });
  const sequence = useRef(0);
  const controller = useRef(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const run = ++sequence.current;
    if (!path) {
      setResult({ data: null, error: null, loading: false });
      return;
    }
    try {
      const data = await request(path, { signal: abort.signal });
      if (run === sequence.current)
        setResult({ data, error: null, loading: false });
    } catch (error) {
      if (error.name !== "AbortError" && run === sequence.current)
        setResult((previous) => ({
          ...previous,
          error: error.message,
          loading: false,
        }));
    }
  }, [path]);
  useEffect(() => {
    setResult({ data: null, error: null, loading: true });
    load();
    const timer = interval
      ? setInterval(() => {
          if (!document.hidden) load();
        }, interval)
      : null;
    return () => {
      sequence.current++;
      controller.current?.abort();
      clearInterval(timer);
    };
  }, [load, interval]);
  return { ...result, reload: load };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = async (action, message) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await action();
      if (message) toast.success(result?.hint || message);
      return result;
    } catch (error) {
      if (error.name !== "AbortError") toast.error(error.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}
export function useDirty(dirty) {
  useEffect(() => {
    if (!dirty) return;
    const id = Symbol();
    dirtyEditors.add(id);
    const prevent = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => {
      dirtyEditors.delete(id);
      window.removeEventListener("beforeunload", prevent);
    };
  }, [dirty]);
}
const dirtyEditors = new Set();
export function canNavigate() {
  return (
    !dirtyEditors.size || window.confirm("有尚未保存的内容，确定离开当前页面？")
  );
}
