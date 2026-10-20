/**
 * Content Script for Incognito URL Router
 * Intercepts in-page link clicks, pre-checks URLs on hover,
 * and routes unvisited/unbookmarked links cleanly into Incognito.
 */

// Local cache to make link clicks instantaneous
const pageDomainCache = new Map();

/**
 * Finds the nearest anchor tag with a valid web href
 * @param {Element} element
 * @returns {HTMLAnchorElement|null}
 */
function getTargetAnchor(element) {
  if (!element || typeof element.closest !== 'function') return null;
  const anchor = element.closest('a[href]');
  if (!anchor) return null;

  const href = anchor.href;
  if (!href) return null;

  // Only intercept http: and https: links
  if (!href.startsWith('http://') && !href.startsWith('https://')) {
    return null;
  }

  // Skip hash-only or same-page anchor jumps
  try {
    const targetUrl = new URL(href, window.location.href);
    if (
      targetUrl.origin === window.location.origin &&
      targetUrl.pathname === window.location.pathname &&
      targetUrl.search === window.location.search &&
      targetUrl.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }

  // Skip explicit download links
  if (anchor.hasAttribute('download')) {
    return null;
  }

  return anchor;
}

/**
 * Displays a subtle, non-intrusive toast notification
 * @param {string} message
 */
function showToast(message) {
  let toast = document.getElementById('__incognito_router_toast__');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '__incognito_router_toast__';
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      backgroundColor: '#1a1b26',
      color: '#f8fafc',
      padding: '10px 16px',
      borderRadius: '8px',
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '13px',
      fontWeight: '500',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      transition: 'opacity 0.25s ease, transform 0.25s ease',
      opacity: '0',
      transform: 'translateY(10px)',
      pointerEvents: 'none',
      border: '1px solid rgba(255, 255, 255, 0.1)'
    });
    document.body.appendChild(toast);
  }

  toast.innerHTML = `<span>🕵️</span><span>${message}</span>`;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 2400);
}

/**
 * Pre-checks a URL with the background worker on mouseover/pointerenter
 */
function prefetchUrlStatus(url) {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.toLowerCase();
    if (pageDomainCache.has(domain)) return;

    chrome.runtime.sendMessage({ action: 'CHECK_URL', url }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      pageDomainCache.set(domain, response.shouldRoute);
    });
  } catch {
    // Ignore invalid URLs
  }
}

// Hover prefetch for responsive clicks
document.addEventListener(
  'pointerover',
  (event) => {
    const anchor = getTargetAnchor(event.target);
    if (anchor) {
      prefetchUrlStatus(anchor.href);
    }
  },
  { capture: true, passive: true }
);

/**
 * Click handler intercepting navigation
 */
async function handleLinkClick(event) {
  // Only handle left click (0) and middle click (1)
  if (event.button !== 0 && event.button !== 1) return;

  const anchor = getTargetAnchor(event.target);
  if (!anchor) return;

  const targetHref = anchor.href;
  let parsedUrl;
  try {
    parsedUrl = new URL(targetHref);
  } catch {
    return;
  }

  const domain = parsedUrl.hostname.toLowerCase();
  const isNewTabIntent =
    event.button === 1 ||
    event.metaKey ||
    event.ctrlKey ||
    anchor.target === '_blank';

  // Check fast local cache
  if (pageDomainCache.has(domain)) {
    const shouldRoute = pageDomainCache.get(domain);
    if (shouldRoute) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      chrome.runtime.sendMessage({ action: 'OPEN_INCOGNITO', url: targetHref }, (res) => {
        if (res && res.success) {
          showToast(`Opened in Incognito tab: ${domain}`);
        }
      });
      return;
    }
    // If not routing, let default browser navigation proceed
    return;
  }

  // Not in local cache: intercept to query background
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  chrome.runtime.sendMessage(
    { action: 'CHECK_AND_ROUTE_LINK', url: targetHref },
    (response) => {
      if (chrome.runtime.lastError || !response) {
        // Fallback to normal navigation on error
        performNavigation(targetHref, isNewTabIntent);
        return;
      }

      if (response.shouldRoute) {
        pageDomainCache.set(domain, true);
        if (response.openResult && response.openResult.success) {
          showToast(`Opened in Incognito tab: ${domain}`);
        }
      } else {
        pageDomainCache.set(domain, false);
        // Continue normal navigation
        performNavigation(targetHref, isNewTabIntent);
      }
    }
  );
}

/**
 * Resumes normal navigation if background determines URL is known
 */
function performNavigation(url, newTab) {
  if (newTab) {
    window.open(url, '_blank');
  } else {
    window.location.assign(url);
  }
}

// Attach listeners at document capturing phase
document.addEventListener('click', handleLinkClick, true);
document.addEventListener('auxclick', handleLinkClick, true);
