import test from "node:test";
import assert from "node:assert/strict";
// Load this browser-only ES module from source without changing the CommonJS backend.
import fs from "node:fs";
const source = fs.readFileSync(
  new URL("../src/lib/api.js", import.meta.url),
  "utf8",
);
const { readEvents } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
test("NDJSON preserves UTF-8 split at every byte boundary and flushes final line", async () => {
  const raw = new TextEncoder().encode('{"text":"你好 🌍"}\n{"final":true}');
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const value of raw) controller.enqueue(Uint8Array.of(value));
        controller.close();
      },
    }),
  );
  const events = [];
  await readEvents(response, (event) => events.push(event));
  assert.deepEqual(events, [{ text: "你好 🌍" }, { final: true }]);
});
