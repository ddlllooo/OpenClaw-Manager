'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.createPageActivity = factory;
})(globalThis, function createPageActivity(options) {
  const doc = options.document;
  const win = options.window;
  const later = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  let active = false, disposed = false, frozen = false, generation = 0;
  let pollTimer = null, renderTimer = null;
  function isActive() { return active && !disposed && !doc.hidden && !frozen; }
  function queueRender() {
    if (!isActive() || renderTimer !== null) return;
    renderTimer = later(() => { renderTimer = null; if (isActive()) options.onRender(); }, options.renderInterval || 5000);
  }
  async function poll(resumed = false) {
    const ownGeneration = generation;
    try { if (isActive()) await options.onPoll(resumed); } catch {} finally {
      if (isActive() && ownGeneration === generation) pollTimer = later(() => { pollTimer = null; poll(); }, options.pollInterval || 15000);
    }
  }
  function pause() {
    if (!active) return;
    active = false; generation++;
    if (pollTimer !== null) cancel(pollTimer);
    if (renderTimer !== null) cancel(renderTimer);
    pollTimer = renderTimer = null;
    options.onDeactivate(); options.onVisibility?.(false);
  }
  function resume() {
    if (active || disposed || doc.hidden || frozen) return;
    active = true; generation++;
    options.onActivate(); options.onVisibility?.(true); poll(true); queueRender();
  }
  function visibility() { if (doc.hidden) pause(); else resume(); }
  function pagehide() { frozen = true; pause(); }
  function pageshow() { frozen = false; resume(); }
  doc.addEventListener('visibilitychange', visibility);
  win?.addEventListener('pagehide', pagehide);
  win?.addEventListener('pageshow', pageshow);
  function dispose() {
    pause(); disposed = true;
    doc.removeEventListener('visibilitychange', visibility);
    win?.removeEventListener('pagehide', pagehide);
    win?.removeEventListener('pageshow', pageshow);
  }
  return { start: resume, isActive, queueRender, dispose };
});
