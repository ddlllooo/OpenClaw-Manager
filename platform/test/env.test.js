'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-env-'));
const loader = path.resolve(__dirname, '../src/env.js');
const file = path.join(scratch, 'private.env');
const fixture = 'fixture-token-from-env-file-0123456789abcdef';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function child(extra = {}, code = '') {
  const env = { ...process.env, OPENCLAW_ENV_FILE: file, ...extra };
  if (extra.MANAGER_AUTH_TOKEN === undefined) delete env.MANAGER_AUTH_TOKEN;
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(loader)}).load();${code}`],
    { cwd: scratch, env, encoding: 'utf8', windowsHide: true });
}

test('loads quoted dotenv configuration independently of the caller directory', () => {
  fs.writeFileSync(file, `# private settings\nMANAGER_AUTH_TOKEN="${fixture}"\nMANAGER_PORT=18123\n`);
  const result = child({}, `process.stdout.write(JSON.stringify({matches:process.env.MANAGER_AUTH_TOKEN===${JSON.stringify(fixture)},port:process.env.MANAGER_PORT}));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { matches: true, port: '18123' });
});

test('nonempty process configuration wins; historical empty Compose token uses the file', () => {
  fs.writeFileSync(file, `MANAGER_AUTH_TOKEN=${fixture}\n`);
  const explicit = child({ MANAGER_AUTH_TOKEN: 'explicit-process-token-0123456789abcdef' },
    'process.stdout.write(String(process.env.MANAGER_AUTH_TOKEN.startsWith("explicit-process")));');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, 'true');
  const empty = child({ MANAGER_AUTH_TOKEN: '' }, `process.stdout.write(String(process.env.MANAGER_AUTH_TOKEN===${JSON.stringify(fixture)}));`);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, 'true');
});

test('short tokens and missing explicitly selected files fail without leaking credentials', () => {
  fs.writeFileSync(file, 'MANAGER_AUTH_TOKEN=private-short-secret\n');
  const invalid = child();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /至少需要 32/);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-short-secret/);
  const missing = child({ OPENCLAW_ENV_FILE: path.join(scratch, 'missing.env') });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /无法读取 Manager 配置文件/);
});

test('blank file token keeps persistent generated-token authentication enabled', () => {
  fs.writeFileSync(file, 'MANAGER_AUTH_TOKEN=\n');
  const result = child({ OPENCLAW_DATA_DIR: path.join(scratch, 'instances') },
    `const security=require(${JSON.stringify(path.resolve(__dirname, '../src/security.js'))});const token=security.managementToken();process.stdout.write(JSON.stringify({generated:/^[a-f0-9]{64}$/.test(token),persisted:require('node:fs').readFileSync(security.credentialFile(),'utf8')===token}));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { generated: true, persisted: true });
});
