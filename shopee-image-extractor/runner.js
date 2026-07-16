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

  // Background tabs (active:false) get their lazy-loaded images throttled by Chrome —
  // the page never actually renders them, so extraction reads null until a human
  // happens to look at the tab. Fix: give the tab its own separate window, unfocused
  // at the OS level (focused:false) so it doesn't steal your screen, but "active"
  // inside that window so Chrome treats it as visible and actually loads images.
  var win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'popup', width: 480, height: 720 });
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
