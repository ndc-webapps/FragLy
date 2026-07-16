// Drives one background tab through a whole list of affiliate links, reading the
// rendered DOM after each navigation. Browser-rendered extraction only — no API calls,
// no server-side fetch. This is what removes the "click through 1300 pages by hand" step.

var state = { running: false, stopRequested: false, items: [], idx: 0, results: [], failedItems: [], tabId: null, windowId: null };

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ── crash/close-proof persistence ───────────────────────────────────────────────
// The runner used to hold results in memory only, so closing the window (or a crash,
// or an accidental navigation) threw away hours of scraping. Now every result is
// mirrored to chrome.storage.local the moment it's fetched, so nothing is ever lost:
// on reopen the runner offers to recover the last run's results AND resume the
// remaining unscraped items from where it stopped.
var saveQueued = false;
function saveProgress() {
  // Debounced to at most one write per ~1.2s so a fast burst of results doesn't spam
  // storage — the trailing write always captures the latest state.
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(function () {
    saveQueued = false;
    chrome.storage.local.set({ fraglyBatchProgress: {
      ts: Date.now(),
      items: state.items,
      idx: state.idx,
      results: state.results,
      failedItems: state.failedItems
    } });
  }, 1200);
}
function saveProgressNow() {
  return new Promise(function (resolve) {
    chrome.storage.local.set({ fraglyBatchProgress: {
      ts: Date.now(),
      items: state.items,
      idx: state.idx,
      results: state.results,
      failedItems: state.failedItems
    } }, resolve);
  });
}
function loadSavedProgress() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['fraglyBatchProgress'], function (r) {
      resolve(r && r.fraglyBatchProgress ? r.fraglyBatchProgress : null);
    });
  });
}
function clearSavedProgress() { chrome.storage.local.remove('fraglyBatchProgress'); }

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Some Shopee images only load once they've entered the viewport (IntersectionObserver
// lazy-load) — a freshly-navigated tab may never trigger that on its own. Nudging the
// scroll position forces those observers to fire before we read the DOM.
function scrollNudge() {
  window.scrollTo(0, document.body.scrollHeight / 2);
  window.scrollTo(0, 0);
}

// Runs inside the target tab via chrome.scripting.executeScript — must be self-contained.
// v2 tried to skip images sharing a gallery container with a <video> element, reasoning
// that a video-first slide's poster renders blank. Verified live against a real product
// page (Royal Kludge RK84): that page has 6 <video> elements from an UNRELATED
// recommendations/reviews carousel elsewhere on the page, and the ancestor-walk check
// flagged the CORRECT main product image as "video-adjacent" just because some unrelated
// video shared a distant ancestor within 5 levels — on a component-based SPA that's true
// of almost any two elements. That heuristic was rejecting good images far more often
// than it was catching real video-poster blanks. Removed it. Confirmed live: picking
// the largest non-avatar susercontent image (no video check at all) matches exactly what
// right-clicking the real displayed image and "copy image address" gives.
// (The canvas-whiteness check was also verified dead in practice — susercontent has no
// CORS headers, so getImageData always throws "tainted canvas" and never actually runs.)
function extractSingleImage() {
  var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
  var candidates = imgs.filter(function (i) {
    return i.src && i.src.indexOf('susercontent') !== -1 && i.className.indexOf('avatar') === -1;
  });
  candidates.sort(function (a, b) { return (b.naturalWidth || 0) - (a.naturalWidth || 0); });
  var best = candidates.filter(function (i) { return (i.naturalWidth || 0) >= 300; })[0] || candidates[0];
  return best ? best.src : null;
}

function logLine(text, ok) {
  var log = document.getElementById('log');
  var div = document.createElement('div');
  div.className = ok ? 'ok-line' : 'fail-line';
  div.textContent = (ok ? '✓ ' : '✗ ') + text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 300) log.removeChild(log.firstChild);
}
function logClear() { document.getElementById('log').innerHTML = ''; }

function fmtEta(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  var s = Math.round(ms / 1000);
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
}

async function tryExtract(tabId) {
  var execResult = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: extractSingleImage });
  return execResult && execResult[0] && execResult[0].result;
}

// Polls instead of sleeping a flat amount: checks every ~900ms and returns the moment
// an image shows up (fast pages don't waste the rest of maxWaitMs), only actually
// waiting the full ceiling for pages that are genuinely slow to render.
async function pollForImage(tabId, maxWaitMs) {
  var start = Date.now();
  var nudged = false;
  while (true) {
    var image = await tryExtract(tabId);
    if (image) return image;
    var elapsed = Date.now() - start;
    if (elapsed >= maxWaitMs) return null;
    if (!nudged && elapsed > 1500) {
      try { await chrome.scripting.executeScript({ target: { tabId: tabId }, func: scrollNudge }); } catch (e) {}
      nudged = true;
    }
    await sleep(Math.min(900, maxWaitMs - elapsed));
  }
}

function updateProgress(done, total, ok, fail, startTime) {
  document.getElementById('statProgress').textContent = done + ' / ' + total;
  document.getElementById('statOk').textContent = ok;
  document.getElementById('statFail').textContent = fail;
  document.getElementById('progressFill').style.width = (done / total * 100).toFixed(1) + '%';
  var elapsed = Date.now() - startTime;
  var avg = elapsed / done;
  document.getElementById('statEta').textContent = fmtEta(avg * (total - done));
}

async function startBatch(resume) {
  if (resume !== true) {
    var raw = document.getElementById('input').value.trim();
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { alert('Invalid JSON — paste the array copied from Admin.'); return; }
    if (!Array.isArray(parsed) || !parsed.length) { alert('Paste a non-empty JSON array first.'); return; }
    state.items = parsed;
    state.idx = 0;
    state.results = [];
    state.failedItems = [];
    logClear();
  } else {
    // Resuming: state.items/idx/results/failedItems already restored from storage.
    // Failed items from the interrupted run get re-queued at the end so they aren't lost.
    logLine('Resuming from item ' + (state.idx + 1) + ' / ' + state.items.length + ' — ' + state.results.length + ' already fetched.', true);
  }
  state.running = true;
  state.stopRequested = false;

  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;
  document.getElementById('outputWrap').style.display = 'none';
  document.getElementById('resumeFailBtn').style.display = 'none';
  document.getElementById('recoverWrap').style.display = 'none';

  // Chrome throttles rendering (not just JS timers) for windows the OS compositor
  // sees as occluded — fully covered by another window on screen — regardless of
  // whether that window has input focus. That's why images kept failing whenever
  // another app/browser window was placed in front of this one.
  // A fully off-screen window (left:-3000) seemed like the fix, but Chrome/Brave
  // reject window bounds that aren't at least 50% within visible screen space —
  // that create() call was throwing, which is why START BATCH did nothing. There's
  // no "always on top" API available to regular extensions, so full immunity to
  // occlusion isn't achievable — the closest compromise: dock it mostly off the
  // right edge of the screen (~60% hanging off), which satisfies the 50% rule while
  // staying out of your way. Keep this corner of your screen clear of other windows
  // while it runs for the most reliable results.
  // left = screenW - visibleWidth, so visibleWidth needs to be the KEPT fraction,
  // not the hidden one — 0.6 here means 60% stays on-screen (40% hangs off the
  // right edge), safely above Chrome's 50% minimum. (Previous build had this
  // inverted — 0.4 meant only 40% visible, which is why it kept getting rejected.)
  var winW = 1366, winH = 900;
  var screenW = (window.screen && window.screen.availWidth) || 1920;
  var left = Math.max(0, screenW - Math.floor(winW * 0.6));
  var win;
  try {
    win = await chrome.windows.create({
      url: 'about:blank', focused: false, type: 'normal',
      width: winW, height: winH,
      left: left, top: 0
    });
  } catch (e) {
    alert('Could not open the runner window: ' + e.message);
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    return;
  }
  var winTabs = await chrome.tabs.query({ windowId: win.id });
  state.tabId = winTabs[0].id;
  state.windowId = win.id;

  var delay = parseInt(document.getElementById('delay').value, 10) || 3000;
  var okCount = state.results.length, failCount = state.failedItems.length;
  var startTime = Date.now();

  // while-loop (not for-loop with idx++): state.idx is advanced AFTER each item is
  // fully processed and BEFORE saving, so the saved idx always points at the next
  // UN-processed item. A resume then never re-scrapes (or duplicates) the last item.
  while (state.idx < state.items.length) {
    if (state.stopRequested) break;
    var item = state.items[state.idx];
    var label = item.name || item.itemId || item.id || ('item ' + state.idx);
    try {
      await chrome.tabs.update(state.tabId, { url: item.link });
      await waitForTabComplete(state.tabId, 8000);
      var image = await pollForImage(state.tabId, delay);
      if (image) {
        state.results.push({ id: item.id, itemId: item.itemId, image: image });
        okCount++;
        logLine(label, true);
      } else {
        state.failedItems.push(item);
        failCount++;
        logLine(label + ' — no image found', false);
      }
    } catch (e) {
      state.failedItems.push(item);
      failCount++;
      logLine(label + ' — ' + e.message, false);
    }
    state.idx++;
    saveProgress(); // mirror to storage after every item so a close/crash loses nothing
    updateProgress(state.idx, state.items.length, okCount, failCount, startTime);
    if (!state.stopRequested && state.idx < state.items.length) {
      await sleep(800 + Math.floor(Math.random() * 1400));
    }
  }
  await saveProgressNow(); // guarantee the final state is flushed past the debounce

  try { await chrome.windows.remove(state.windowId); } catch (e) {}
  state.tabId = null;
  state.windowId = null;
  state.running = false;
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
  finishBatch();
}

function finishBatch() {
  document.getElementById('output').value = JSON.stringify(state.results, null, 2);
  document.getElementById('outputWrap').style.display = 'block';
  if (state.failedItems.length) {
    document.getElementById('resumeFailBtn').style.display = 'block';
    document.getElementById('resumeFailBtn').textContent = 'RETRY ' + state.failedItems.length + ' FAILED';
  }
  // Saved progress is intentionally NOT cleared here — results stay recoverable even
  // after a finished run, in case APPLY in the admin fails and the window gets closed.
  // The user discards it explicitly once images are safely applied.
}

document.getElementById('startBtn').addEventListener('click', function () { startBatch(false); });

document.getElementById('stopBtn').addEventListener('click', function () {
  state.stopRequested = true;
  document.getElementById('stopBtn').disabled = true;
});

document.getElementById('copyBtn').addEventListener('click', function () {
  var output = document.getElementById('output');
  var btn = document.getElementById('copyBtn');
  navigator.clipboard.writeText(output.value).then(function () {
    btn.textContent = 'COPIED!';
    setTimeout(function () { btn.textContent = 'COPY RESULT JSON'; }, 1500);
  });
});

document.getElementById('resumeFailBtn').addEventListener('click', function () {
  document.getElementById('input').value = JSON.stringify(state.failedItems, null, 2);
  document.getElementById('outputWrap').style.display = 'none';
  window.scrollTo(0, 0);
});

// ── recovery panel (shown on load if a prior run left saved progress) ──
async function initRecovery() {
  var saved = await loadSavedProgress();
  var wrap = document.getElementById('recoverWrap');
  if (!saved || !saved.items || !saved.items.length) { wrap.style.display = 'none'; return; }
  // Restore into memory so Recover/Resume act on it.
  state.items = saved.items;
  state.idx = saved.idx || 0;
  state.results = saved.results || [];
  state.failedItems = saved.failedItems || [];
  var remaining = Math.max(0, state.items.length - state.idx);
  var when = new Date(saved.ts || Date.now()).toLocaleString();
  document.getElementById('recoverMsg').textContent =
    state.results.length + ' images already fetched, ' + remaining + ' items not yet done (last run ' + when + ').';
  document.getElementById('resumeBtn').style.display = remaining > 0 ? 'block' : 'none';
  wrap.style.display = 'block';
}

document.getElementById('recoverBtn').addEventListener('click', function () {
  // Just surface the already-fetched results for copy → admin APPLY, no re-scraping.
  document.getElementById('output').value = JSON.stringify(state.results, null, 2);
  document.getElementById('outputWrap').style.display = 'block';
  if (state.failedItems.length) {
    document.getElementById('resumeFailBtn').style.display = 'block';
    document.getElementById('resumeFailBtn').textContent = 'RETRY ' + state.failedItems.length + ' FAILED';
  }
  document.getElementById('output').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('resumeBtn').addEventListener('click', function () {
  startBatch(true); // continue scraping the remaining items from where it stopped
});

document.getElementById('discardBtn').addEventListener('click', function () {
  if (!confirm('Discard the saved results from the last run? Only do this after you have applied them in the admin.')) return;
  clearSavedProgress();
  state.items = []; state.idx = 0; state.results = []; state.failedItems = [];
  document.getElementById('recoverWrap').style.display = 'none';
});

initRecovery();

window.addEventListener('beforeunload', function () {
  if (state.windowId) chrome.windows.remove(state.windowId).catch(function () {});
});
