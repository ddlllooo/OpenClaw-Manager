import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test(
  "production Express entry serves built React under CSP and preserves API authentication",
  { timeout: 30000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const scratch = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-react-smoke-"),
    );
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const credential = crypto.randomBytes(32).toString("hex");
    const envFile = path.join(scratch, "manager.env");
    fs.writeFileSync(envFile, `MANAGER_AUTH_TOKEN=${credential}\n`, {
      mode: 0o600,
    });
    const env = {
      ...process.env,
      MANAGER_PORT: String(port),
      MANAGER_BIND_ADDRESS: "127.0.0.1",
      OPENCLAW_ENV_FILE: envFile,
      OPENCLAW_DATA_DIR: path.join(scratch, "instances"),
      OPENCLAW_STARTUP_HOME: scratch,
      OPENCLAW_BACKUP_DIR: path.join(scratch, "backups"),
      OPENCLAW_SSH_STATE_DIR: path.join(scratch, "ssh"),
    };
    delete env.MANAGER_AUTH_TOKEN;
    for (const key of [
      "OPENCLAW_CONTROL_SOCKET",
      "MANAGER_CONTAINERIZED",
      "OPENCLAW_CHANNEL_BRIDGE_LISTEN",
      "OPENCLAW_WEB_LAUNCH_TOKEN",
      "OPENCLAW_HOST_CONTROL_DIR",
    ])
      delete env[key];
    const child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exit = once(child, "exit");
    try {
      const deadline = Date.now() + 15000;
      while (!output.includes("OpenClaw Manager listening")) {
        if (child.exitCode !== null || Date.now() >= deadline)
          throw new Error(`Isolated manager did not start: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const base = `http://127.0.0.1:${port}`;
      const page = await fetch(base);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /data-manager-ui="react"/);
      assert.doesNotMatch(
        html,
        /src="\/(?:app|devices|features|management)\.js/,
      );
      assert.match(
        page.headers.get("content-security-policy"),
        /script-src 'self'/,
      );
      assert.equal((await fetch(`${base}/app.js`)).status, 404);
      assert.equal((await fetch(`${base}/.env`)).status, 404);
      const script = /src="([^"]+\.js)"/.exec(html)[1];
      assert.equal((await fetch(new URL(script, base))).status, 200);
      assert.equal((await fetch(`${base}/api/instances`)).status, 401);
      const session = await fetch(`${base}/api/session`, {
        headers: { Authorization: `Bearer ${credential}` },
      });
      assert.equal(session.status, 200);
      const { csrf } = await session.json();
      assert.ok(csrf);
      const cookie = session.headers.get("set-cookie").split(";")[0];
      const instances = await fetch(`${base}/api/instances`, {
        headers: { Cookie: cookie },
      });
      assert.equal(instances.status, 200);
      assert.deepEqual((await instances.json()).instances, []);
      const logout = await fetch(`${base}/api/session`, {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
      assert.equal(
        (await fetch(`${base}/api/instances`, { headers: { Cookie: cookie } }))
          .status,
        401,
      );
    } finally {
      child.kill();
      await exit;
      assert.ok(
        path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep),
      );
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);
