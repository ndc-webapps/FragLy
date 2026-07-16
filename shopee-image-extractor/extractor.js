// Injected into the Shopee page tab.
// Reads the already-rendered DOM — no API calls, no scraping.
// Returns array of { itemId, title, image }.
function extractShopeeProducts() {
  var results = [];
  var seen = new Set();

  function itemIdFromUrl(url) {
    if (!url) return null;
    var m = url.match(/\/product\/\d+\/(\d+)/);
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
      '[class*="product-name"]', '[class*="item-name"]', '[class*="ProductName"]',
      '[class*="ItemName"]', '[class*="title"]', '[class*="name"]'
    ];
    for (var i = 0; i < tries.length; i++) {
      var el = card.querySelector(tries[i]);
      if (el && el.textContent.trim().length > 4) return el.textContent.trim().slice(0, 120);
    }
    return (fallback || '').slice(0, 120);
  }

  // Walk up from a link to find a card-like ancestor that contains an image
  function findCard(anchor) {
    var el = anchor.parentElement;
    for (var i = 0; i < 12 && el; i++) {
      if (el.querySelectorAll('img[src*="susercontent"]').length > 0 && el.offsetHeight > 60) return el;
      el = el.parentElement;
    }
    return anchor.closest('[class*="card"],[class*="item"],[class*="product"],[class*="list-item"]') || anchor.parentElement;
  }

  // Strategy 1: links containing /product/{shopId}/{itemId}
  Array.from(document.querySelectorAll('a[href*="/product/"]')).forEach(function(a) {
    var itemId = itemIdFromUrl(a.href);
    if (!itemId || seen.has(itemId)) return;
    seen.add(itemId);
    var card = findCard(a);
    results.push({
      itemId: itemId,
      title: cardTitle(card, a.textContent.trim()),
      image: bestImage(card)
    });
  });

  // Strategy 2: data attributes (some Shopee pages embed itemId in DOM)
  if (results.length === 0) {
    Array.from(document.querySelectorAll('[data-item-id],[data-itemid],[data-product-id]')).forEach(function(el) {
      var itemId = el.dataset.itemId || el.dataset.itemid || el.dataset.productId;
      if (!itemId || !/^\d+$/.test(itemId) || seen.has(itemId)) return;
      seen.add(itemId);
      results.push({
        itemId: itemId,
        title: cardTitle(el, ''),
        image: bestImage(el)
      });
    });
  }

  // Strategy 3: scan all images with susercontent, try to pull itemId from nearby links
  if (results.length === 0) {
    Array.from(document.querySelectorAll('img[src*="susercontent"]')).forEach(function(img) {
      if (img.className.includes('avatar')) return;
      // Look for a nearby anchor
      var parent = img.parentElement;
      for (var i = 0; i < 8 && parent; i++) {
        var link = parent.querySelector('a[href*="/product/"]');
        if (link) {
          var itemId = itemIdFromUrl(link.href);
          if (itemId && !seen.has(itemId)) {
            seen.add(itemId);
            results.push({
              itemId: itemId,
              title: cardTitle(parent, link.textContent.trim()),
              image: img.src
            });
          }
          break;
        }
        parent = parent.parentElement;
      }
    });
  }

  return results;
}
