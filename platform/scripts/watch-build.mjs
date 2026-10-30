#!/usr/bin/env node
// Dev helper: rebuild the .app from source after any change to server.js,
// src/**, public/**, electron/**. Watches the tree, kills the running app,
// repacks with electron-builder (dir target — fast, no dmg), and relaunches.
//
//   npm run watch                 # build + run, rebuild on change
//   npm run watch -- --once       # single rebuild + relaunch, then exit

import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const once = process.argv.includes('--once');

const watchRoots = [
  path.join(root, 'server.js'),
  path.join(root, 'src'),
  path.join(root, 'frontend'),
  path.join(root, 'vite.config.mjs'),
  path.join(root, 'electron'),
];

const APP_PATH = process.platform==='darwin'
  ? path.join(root,'dist',process.arch==='arm64'?'mac-arm64':'mac','OpenClaw Manager.app','Contents','MacOS','OpenClaw Manager')
  : process.platform==='win32'
    ? path.join(root,'dist',process.arch==='arm64'?'win-arm64-unpacked':'win-unpacked','OpenClaw Manager.exe')
    : path.join(root,'dist',process.arch==='arm64'?'linux-arm64-unpacked':'linux-unpacked','openclaw-docker');

let building = false;
let rebuildQueued = false;
let running = null;
let shuttingDown = false;

function log(msg) { console.log(`[watch] ${msg}`); }

function killRunning() {
  if (!running || running.exitCode !== null) return;
  log('stopping running app…');
  running.kill('SIGTERM');
  const t = setTimeout(() => { try { running.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
  running.once('exit', () => clearTimeout(t));
}

function buildAndRun() {
  building = true;
  log('building .app (electron-builder --dir)…');
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(root,'node_modules/electron-builder/cli.js'), '--dir', '--publish', 'never'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  building = false;
  if (res.status !== 0) {
    console.error(res.stdout || '');
    console.error(res.stderr || '');
    log('build FAILED — fix the error; watching for changes.');
    return;
  }
  log(`build ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  killRunning();
  if (running && running.exitCode === null) {
    // wait for the old process to exit before relaunching
    running.once('exit', launch);
  } else {
    launch();
  }
}

function launch() {
  if (shuttingDown) return;
  log('launching OpenClaw Manager…');
  running = spawn(APP_PATH, [], { stdio: 'ignore', windowsHide:true });
  running.on('error',error=>log('launch failed: '+error.message));
}

function scheduleRebuild(reason) {
  if (once) return;
  if (building) { rebuildQueued = true; return; }
  log(`change detected (${reason})`);
  buildAndRun();
}

// Initial build + run.
buildAndRun();

if (once) process.exit(0);

for (const target of watchRoots) {
  watch(target, { recursive: true }, (_event, filename) => {
    if (filename && /(^|\/)\.DS_Store$/.test(filename)) return;
    scheduleRebuild(filename || target);
  });
}

log('watching server.js, src/, public/, electron/ — Ctrl+C to stop');
process.on('SIGINT', () => {
  shuttingDown = true;
  killRunning();
  process.exit(0);
});
