var extractorCode = `
function extractShopeeProducts() {
  var results = [];
  var seen = new Set();

  function itemIdFromUrl(url) {
    if (!url) return null;
    var m = url.match(/\\/product\\/\\d+\\/(\\d+)/);
    if (m) return m[1];
    try {
      var u = new URL(url);
      return u.searchParams.get('itemId') || u.searchParams.get('item_id') || null;
    } catch (e) { return null; }
  }

  function bestImage(el) {
    if (!el) return '';
    var imgs = Array.from(el.querySelectorAll('img'));
    var large = imgs.find(function(i) {
      return i.src && i.src.includes('susercontent') &&
        !i.className.includes('avatar') &&
        (i.naturalWidth >= 100 || i.width >= 100);
    });
    if (large) return large.src;
    var any = imgs.find(function(i) { return i.src && i.src.includes('susercontent'); });
    return any ? any.src : '';
  }

  function cardTitle(card, fallback) {
    if (!card) return (fallback || '').slice(0, 120);
    var tries = [
      '[class*="product-name"]','[class*="item-name"]','[class*="ProductName"]',
      '[class*="ItemName"]','[class*="title"]','[class*="name"]'
    ];
    for (var i = 0; i < tries.length; i++) {
      var el = card.querySelector(tries[i]);
      if (el && el.textContent.trim().length > 4) return el.textContent.trim().slice(0, 120);
    }
    return (fallback || '').slice(0, 120);
  }

  function findCard(anchor) {
    var el = anchor.parentElement;
    for (var i = 0; i < 12 && el; i++) {
      if (el.querySelectorAll('img[src*="susercontent"]').length > 0 && el.offsetHeight > 60) return el;
      el = el.parentElement;
    }
    return anchor.closest('[class*="card"],[class*="item"],[class*="product"],[class*="list-item"]') || anchor.parentElement;
  }

  Array.from(document.querySelectorAll('a[href*="/product/"]')).forEach(function(a) {
    var itemId = itemIdFromUrl(a.href);
    if (!itemId || seen.has(itemId)) return;
    seen.add(itemId);
    var card = findCard(a);
    results.push({ itemId: itemId, title: cardTitle(card, a.textContent.trim()), image: bestImage(card) });
  });

  if (results.length === 0) {
    Array.from(document.querySelectorAll('[data-item-id],[data-itemid],[data-product-id]')).forEach(function(el) {
      var itemId = el.dataset.itemId || el.dataset.itemid || el.dataset.productId;
      if (!itemId || !/^\\d+$/.test(itemId) || seen.has(itemId)) return;
      seen.add(itemId);
      results.push({ itemId: itemId, title: cardTitle(el, ''), image: bestImage(el) });
    });
  }

  if (results.length === 0) {
    Array.from(document.querySelectorAll('img[src*="susercontent"]')).forEach(function(img) {
      if (img.className.includes('avatar')) return;
      var parent = img.parentElement;
      for (var i = 0; i < 8 && parent; i++) {
        var link = parent.querySelector('a[href*="/product/"]');
        if (link) {
          var itemId = itemIdFromUrl(link.href);
          if (itemId && !seen.has(itemId)) {
            seen.add(itemId);
            results.push({ itemId: itemId, title: cardTitle(parent, link.textContent.trim()), image: img.src });
          }
          break;
        }
        parent = parent.parentElement;
      }
    });
  }

  return results;
}
extractShopeeProducts();
`;

var missingSet = null; // null = no list loaded, extractor returns everything unfiltered

function loadMissingList() {
  chrome.storage.local.get(['fraglyMissingList'], function(res) {
    var list = res.fraglyMissingList || [];
    missingSet = list.length ? new Set(list) : null;
    var status = document.getElementById('missingStatus');
    status.textContent = list.length ? list.length + ' itemIds loaded — extraction will filter to these.' : 'No list loaded — extraction shows everything on the page.';
    document.getElementById('missingInput').value = list.length ? JSON.stringify(list) : '';
  });
}

document.getElementById('saveMissingBtn').addEventListener('click', function() {
  var raw = document.getElementById('missingInput').value.trim();
  var status = document.getElementById('missingStatus');
  if (!raw) {
    chrome.storage.local.remove('fraglyMissingList', function() {
      missingSet = null;
      status.textContent = 'List cleared — extraction shows everything on the page.';
    });
    return;
  }
  var parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    status.textContent = 'Invalid JSON — paste the array copied from Admin.';
    return;
  }
  if (!Array.isArray(parsed)) {
    status.textContent = 'Expected a JSON array of itemIds.';
    return;
  }
  parsed = parsed.map(String);
  chrome.storage.local.set({ fraglyMissingList: parsed }, function() {
    missingSet = new Set(parsed);
    status.textContent = parsed.length + ' itemIds saved — extraction will filter to these.';
  });
});

loadMissingList();

document.getElementById('batchBtn').addEventListener('click', function () {
  chrome.windows.create({ url: chrome.runtime.getURL('runner.html'), type: 'popup', width: 520, height: 720 });
});

document.getElementById('extractBtn').addEventListener('click', function() {
  var btn = document.getElementById('extractBtn');
  var status = document.getElementById('status');
  var output = document.getElementById('output');
  var copyBtn = document.getElementById('copyBtn');

  btn.disabled = true;
  btn.textContent = 'EXTRACTING…';
  status.className = 'status';
  status.textContent = 'Running…';

  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (!tabs || !tabs[0]) {
      status.className = 'status err';
      status.textContent = 'No active tab found.';
      btn.disabled = false;
      btn.textContent = 'EXTRACT PRODUCTS';
      return;
    }

    chrome.scripting.executeScript(
      { target: { tabId: tabs[0].id }, func: new Function(extractorCode) },
      function(results) {
        btn.disabled = false;
        btn.textContent = 'EXTRACT PRODUCTS';

        if (chrome.runtime.lastError) {
          status.className = 'status err';
          status.textContent = 'Error: ' + chrome.runtime.lastError.message;
          return;
        }

        var data = results && results[0] && results[0].result;
        if (!data || !data.length) {
          status.className = 'status err';
          status.textContent = 'No products found. Make sure product cards are visible on the page.';
          return;
        }

        var totalFound = data.length;
        if (missingSet) {
          data = data.filter(function(row) { return missingSet.has(String(row.itemId)); });
        }

        if (!data.length) {
          output.style.display = 'none';
          copyBtn.style.display = 'none';
          status.className = 'status warn';
          status.textContent = totalFound + ' products on page, none match your missing list. Try another page/category.';
          return;
        }

        var json = JSON.stringify(data, null, 2);
        output.value = json;
        output.style.display = 'block';
        copyBtn.style.display = 'block';
        status.className = 'status ok';
        status.textContent = missingSet
          ? data.length + ' of ' + totalFound + ' match your missing list.'
          : data.length + ' product' + (data.length === 1 ? '' : 's') + ' extracted (no missing list loaded — showing all).';
      }
    );
  });
});

document.getElementById('copyBtn').addEventListener('click', function() {
  var output = document.getElementById('output');
  var btn = document.getElementById('copyBtn');
  navigator.clipboard.writeText(output.value).then(function() {
    btn.textContent = 'COPIED!';
    setTimeout(function() { btn.textContent = 'COPY JSON'; }, 1500);
  });
});
