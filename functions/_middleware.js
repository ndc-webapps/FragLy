// Runs on every request before any route/static asset. Only job: if someone hits the old
// fragly.pages.dev URL (bookmarks, old shared links, whatever's already indexed), send
// them to the real domain instead of serving a duplicate copy of the site there.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname.endsWith('.pages.dev')) {
    url.hostname = 'topfragly.com';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
