let csrf = null;
export async function authenticate(token, signal) {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || "认证失败"), {
      status: response.status,
    });
  csrf = data.csrf;
}
export async function logout() {
  try {
    await request("/api/session", { method: "DELETE", body: {} });
  } catch (error) {
    if (error.status !== 401) throw error;
  }
  csrf = null;
}
export async function request(
  path,
  { method = "GET", body, signal, raw = false } = {},
) {
  const response = await fetch(path, {
    method,
    signal,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET"
        ? { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401 && csrf !== null)
    window.dispatchEvent(new Event("manager:unauthorized"));
  if (raw && response.ok) return response;
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || `请求失败 (${response.status})`),
      { status: response.status },
    );
  return data;
}
// NDJSON parser preserves split Unicode characters and a final unterminated line.
export async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
      if (done) {
        if (buffer.trim()) onEvent(JSON.parse(buffer));
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
