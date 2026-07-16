// Drives one background tab through a whole list of affiliate links, reading the
// rendered DOM after each navigation. Browser-rendered extraction only — no API calls,
// no server-side fetch. This is what removes the "click through 1300 pages by hand" step.

var state = { running: false, stopRequested: false, items: [], idx: 0, results: [], failedItems: [], tabId: null, windowId: null };

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

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

async function startBatch() {
  var raw = document.getElementById('input').value.trim();
  var parsed;
  try { parsed = JSON.parse(raw); } catch (e) { alert('Invalid JSON — paste the array copied from Admin.'); return; }
  if (!Array.isArray(parsed) || !parsed.length) { alert('Paste a non-empty JSON array first.'); return; }

  state.items = parsed;
  state.idx = 0;
  state.results = [];
  state.failedItems = [];
  state.running = true;
  state.stopRequested = false;

  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;
  document.getElementById('outputWrap').style.display = 'none';
  document.getElementById('resumeFailBtn').style.display = 'none';
  logClear();

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
  var okCount = 0, failCount = 0;
  var startTime = Date.now();

  for (; state.idx < state.items.length; state.idx++) {
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
    updateProgress(state.idx + 1, state.items.length, okCount, failCount, startTime);
    if (!state.stopRequested && state.idx < state.items.length - 1) {
      await sleep(800 + Math.floor(Math.random() * 1400));
    }
  }

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
}

document.getElementById('startBtn').addEventListener('click', startBatch);

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

window.addEventListener('beforeunload', function () {
  if (state.windowId) chrome.windows.remove(state.windowId).catch(function () {});
});
