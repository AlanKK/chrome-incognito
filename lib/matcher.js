/**
 * Core URL analysis, normalization, and bookmark/history matching logic
 * for Incognito URL Router.
 */

// Common second-level labels used under country code top-level domains (ccTLDs)
const COMMON_SLD_PREFIXES = new Set([
  'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'ne', 'gen', 'mil', 'nom', 'res'
]);

/**
 * Normalizes a URL string. Returns null if invalid or unsupported protocol.
 * @param {string} urlStr
 * @returns {URL|null}
 */
export function parseUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const url = new URL(urlStr);
    return url;
  } catch {
    return null;
  }
}

/**
 * Checks whether the URL is a standard web URL (http: or https:)
 * @param {URL|string} url
 * @returns {boolean}
 */
export function isWebUrl(url) {
  const parsed = typeof url === 'string' ? parseUrl(url) : url;
  if (!parsed) return false;
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Checks if the URL should be completely ignored (e.g. chrome://, about:blank, localhost)
 * @param {URL|string} url
 * @returns {boolean}
 */
export function isInternalOrIgnoredUrl(url) {
  const parsed = typeof url === 'string' ? parseUrl(url) : url;
  if (!parsed) return true;

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return true;
  }

  return false;
}

/**
 * Extracts the base / registrable domain from a hostname.
 * Example: 'sub.news.example.com' -> 'example.com'
 * Example: 'dept.gov.au' -> 'dept.gov.au'
 * @param {string} hostname
 * @returns {string}
 */
export function getBaseDomain(hostname) {
  if (!hostname) return '';
  const cleanHost = hostname.toLowerCase().trim();

  // If IP address or localhost
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(cleanHost) || cleanHost === 'localhost') {
    return cleanHost;
  }

  const parts = cleanHost.split('.');
  if (parts.length <= 2) {
    return cleanHost;
  }

  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];

  // If it's a 2-letter country code with a common 2nd-level label (e.g. .co.uk, .gov.au)
  if (tld.length === 2 && COMMON_SLD_PREFIXES.has(sld) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }

  return parts.slice(-2).join('.');
}

/**
 * Checks if a hostname matches any domain in the whitelist.
 * @param {string} hostname
 * @param {string[]} whitelist
 * @returns {boolean}
 */
export function isWhitelisted(hostname, whitelist = []) {
  if (!hostname || !Array.isArray(whitelist) || whitelist.length === 0) {
    return false;
  }

  const cleanHost = hostname.toLowerCase().trim();
  const baseDomain = getBaseDomain(cleanHost);

  for (const item of whitelist) {
    if (!item) continue;
    const rule = item.toLowerCase().trim();
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (cleanHost === suffix || cleanHost.endsWith('.' + suffix)) {
        return true;
      }
    } else {
      if (cleanHost === rule || baseDomain === rule || cleanHost.endsWith('.' + rule)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Safely calls a Chrome API method that might return a Promise or take a callback.
 * Guaranteed never to hang even if neither is properly called.
 */
async function callAsyncApi(fn, ...args) {
  if (typeof fn !== 'function') return [];
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => {
      if (!resolved) {
        resolved = true;
        resolve(val || []);
      }
    };

    // 1000ms safety timeout to ensure extension never hangs
    const timer = setTimeout(() => done([]), 1000);

    try {
      const res = fn(...args, (cbResult) => {
        clearTimeout(timer);
        done(cbResult);
      });
      if (res && typeof res.then === 'function') {
        res.then((val) => {
          clearTimeout(timer);
          done(val);
        }).catch(() => {
          clearTimeout(timer);
          done([]);
        });
      }
    } catch {
      clearTimeout(timer);
      done([]);
    }
  });
}

/**
 * Checks whether a URL or its domain is present in bookmarks.
 * @param {string} targetUrl
 * @param {object} bookmarksApi - chrome.bookmarks or mock
 * @param {'domain'|'exact'} mode
 * @returns {Promise<{ found: boolean, title?: string, url?: string }>}
 */
export async function checkBookmarks(targetUrl, bookmarksApi, mode = 'domain') {
  if (!bookmarksApi || typeof bookmarksApi.search !== 'function') {
    return { found: false };
  }

  const parsed = parseUrl(targetUrl);
  if (!parsed) return { found: false };

  const targetHost = parsed.hostname.toLowerCase();
  const targetBaseDomain = getBaseDomain(targetHost);

  try {
    if (mode === 'exact') {
      // In exact mode, remove trailing slash and hash for normalized search
      const cleanUrl = parsed.origin + parsed.pathname.replace(/\/$/, '') + parsed.search;
      const results = await callAsyncApi(bookmarksApi.search.bind(bookmarksApi), { url: targetUrl });

      if (results && results.length > 0) {
        return { found: true, title: results[0].title, url: results[0].url };
      }

      // Try normalized url search
      const normalizedResults = await callAsyncApi(bookmarksApi.search.bind(bookmarksApi), { url: cleanUrl });

      if (normalizedResults && normalizedResults.length > 0) {
        return { found: true, title: normalizedResults[0].title, url: normalizedResults[0].url };
      }

      return { found: false };
    }

    // Domain mode: search by base domain or host
    const query = targetBaseDomain || targetHost;
    const results = await callAsyncApi(bookmarksApi.search.bind(bookmarksApi), query);

    if (!Array.isArray(results)) return { found: false };

    for (const item of results) {
      if (!item.url) continue;
      const itemParsed = parseUrl(item.url);
      if (!itemParsed) continue;

      const itemHost = itemParsed.hostname.toLowerCase();
      const itemBaseDomain = getBaseDomain(itemHost);

      if (itemHost === targetHost || itemBaseDomain === targetBaseDomain) {
        return { found: true, title: item.title, url: item.url };
      }
    }

    return { found: false };
  } catch (err) {
    console.error('Error checking bookmarks:', err);
    return { found: false };
  }
}

/**
 * Checks whether a URL or its domain is present in history.
 * @param {string} targetUrl
 * @param {object} historyApi - chrome.history or mock
 * @param {'domain'|'exact'} mode
 * @returns {Promise<{ found: boolean, visitCount?: number, url?: string }>}
 */
export async function checkHistory(targetUrl, historyApi, mode = 'domain') {
  if (!historyApi) return { found: false };

  const parsed = parseUrl(targetUrl);
  if (!parsed) return { found: false };

  const targetHost = parsed.hostname.toLowerCase();
  const targetBaseDomain = getBaseDomain(targetHost);

  try {
    if (mode === 'exact') {
      if (typeof historyApi.getVisits === 'function') {
        const visits = await callAsyncApi(historyApi.getVisits.bind(historyApi), { url: targetUrl });
        if (visits && visits.length > 0) {
          return { found: true, visitCount: visits.length, url: targetUrl };
        }
      }

      // Fallback or secondary check with history.search
      if (typeof historyApi.search === 'function') {
        const results = await callAsyncApi(historyApi.search.bind(historyApi), { text: targetUrl, startTime: 0, maxResults: 5 });
        const exactMatch = results?.find((r) => r.url === targetUrl);
        if (exactMatch) {
          return { found: true, visitCount: exactMatch.visitCount || 1, url: exactMatch.url };
        }
      }

      return { found: false };
    }

    // Domain mode
    if (typeof historyApi.search === 'function') {
      const query = targetBaseDomain || targetHost;
      const results = await callAsyncApi(historyApi.search.bind(historyApi), { text: query, startTime: 0, maxResults: 30 });

      if (!Array.isArray(results)) return { found: false };

      for (const item of results) {
        if (!item.url) continue;
        const itemParsed = parseUrl(item.url);
        if (!itemParsed) continue;

        const itemHost = itemParsed.hostname.toLowerCase();
        const itemBaseDomain = getBaseDomain(itemHost);

        if (itemHost === targetHost || itemBaseDomain === targetBaseDomain) {
          return { found: true, visitCount: item.visitCount || 1, url: item.url };
        }
      }
    }

    return { found: false };
  } catch (err) {
    console.error('Error checking history:', err);
    return { found: false };
  }
}

/**
 * Evaluates whether a URL should be routed to an Incognito tab.
 * @param {string} targetUrl
 * @param {object} options
 * @param {object} options.bookmarksApi
 * @param {object} options.historyApi
 * @param {object} [options.settings]
 * @param {Map} [options.cache]
 * @returns {Promise<{ shouldRoute: boolean, reason: string, details?: object }>}
 */
export async function shouldRouteToIncognito(targetUrl, { bookmarksApi, historyApi, settings = {}, cache = null } = {}) {
  const enabled = settings.enabled !== false;
  if (!enabled) {
    return { shouldRoute: false, reason: 'extension_disabled' };
  }

  const parsed = parseUrl(targetUrl);
  if (!parsed || isInternalOrIgnoredUrl(parsed)) {
    return { shouldRoute: false, reason: 'internal_or_ignored' };
  }

  const host = parsed.hostname.toLowerCase();
  const baseDomain = getBaseDomain(host);
  const mode = settings.matchMode === 'exact' ? 'exact' : 'domain';
  const whitelist = settings.whitelist || [];

  if (isWhitelisted(host, whitelist)) {
    return { shouldRoute: false, reason: 'whitelisted' };
  }

  // Check cache key
  const cacheKey = mode === 'exact' ? targetUrl : baseDomain;
  if (cache && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    return { shouldRoute: cached.shouldRoute, reason: cached.reason + '_cached', details: cached.details };
  }

  // 1. Check bookmarks
  const bookmarkResult = await checkBookmarks(targetUrl, bookmarksApi, mode);
  if (bookmarkResult.found) {
    const decision = { shouldRoute: false, reason: 'bookmarked', details: bookmarkResult };
    if (cache) cache.set(cacheKey, decision);
    return decision;
  }

  // 2. Check history
  const historyResult = await checkHistory(targetUrl, historyApi, mode);
  if (historyResult.found) {
    const decision = { shouldRoute: false, reason: 'history', details: historyResult };
    if (cache) cache.set(cacheKey, decision);
    return decision;
  }

  // 3. Not in bookmarks and not in history -> Route to Incognito
  const decision = { shouldRoute: true, reason: 'unvisited_unbookmarked' };
  if (cache) cache.set(cacheKey, decision);
  return decision;
}
