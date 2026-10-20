/**
 * Content Script for Incognito URL Router
 * Intercepts in-page link clicks, pre-checks URLs on hover,
 * unwraps redirect tracking links (Gmail, Outlook, etc.),
 * and routes unvisited/unbookmarked links cleanly into Incognito.
 */

(() => {
  // Prevent duplicate execution if script is re-injected or reloaded
  if (window.__incognitoUrlRouterLoaded) return;
  window.__incognitoUrlRouterLoaded = true;

  // Local cache to make link clicks instantaneous
  const pageDomainCache = new Map();

  /**
   * Unwraps tracking/redirect URLs (e.g. Gmail google.com/url?q=..., Outlook SafeLinks, etc.)
   */
  function unwrapUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return urlStr;
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      let candidate = null;

      if (host.includes('google.') && pathname === '/url') {
        candidate = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      } else if (host.includes('safelinks.protection.outlook.com')) {
        candidate = parsed.searchParams.get('url');
      } else if (host.includes('facebook.com') && pathname.endsWith('/l.php')) {
        candidate = parsed.searchParams.get('u');
      } else if (host.includes('slack-redir.net')) {
        candidate = parsed.searchParams.get('url');
      } else {
        const REDIRECT_PARAMS = ['q', 'url', 'u', 'target', 'dest', 'destination', 'redirect', 'link'];
        for (const p of REDIRECT_PARAMS) {
          const val = parsed.searchParams.get(p);
          if (val && (val.startsWith('http://') || val.startsWith('https://'))) {
            candidate = val;
            break;
          }
        }
      }

      if (candidate) {
        const decoded = decodeURIComponent(candidate);
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
          return unwrapUrl(decoded);
        }
      }
    } catch {
      // Ignore URL parse error
    }
    return urlStr;
  }

  /**
   * Extracts the intended destination URL from an anchor, checking data-saferedirecturl and href
   * @param {HTMLAnchorElement} anchor
   * @returns {string|null}
   */
  function extractDestinationUrl(anchor) {
    if (!anchor) return null;
    const safeRedirect = anchor.getAttribute('data-saferedirecturl');
    const rawHref = anchor.href;
    const urlToTest = safeRedirect || rawHref;
    if (!urlToTest) return null;

    const unwrapped = unwrapUrl(urlToTest);
    if (!unwrapped.startsWith('http://') && !unwrapped.startsWith('https://')) {
      return null;
    }
    return unwrapped;
  }

  /**
   * Finds the nearest anchor tag with a valid web href
   * @param {Element} element
   * @returns {HTMLAnchorElement|null}
   */
  function getTargetAnchor(element) {
    if (!element || typeof element.closest !== 'function') return null;
    const anchor = element.closest('a[href], a[data-saferedirecturl]');
    if (!anchor) return null;

    const destination = extractDestinationUrl(anchor);
    if (!destination) return null;

    // Skip hash-only or same-page anchor jumps
    try {
      const targetUrl = new URL(destination, window.location.href);
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
        const dest = extractDestinationUrl(anchor);
        if (dest) {
          prefetchUrlStatus(dest);
        }
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

    const targetHref = extractDestinationUrl(anchor);
    if (!targetHref) return;

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
          } else if (res?.error === 'NO_INCOGNITO_ACCESS') {
            showToast('⚠️ Enable "Allow in Incognito" in chrome://extensions');
            performNavigation(targetHref, isNewTabIntent);
          }
        });
        return;
      }
    }

    // Intercept to query background
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    chrome.runtime.sendMessage(
      { action: 'CHECK_AND_ROUTE_LINK', url: targetHref, isNewTab: isNewTabIntent },
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
          } else if (response.openResult?.error === 'NO_INCOGNITO_ACCESS') {
            showToast('⚠️ Enable "Allow in Incognito" in chrome://extensions');
            performNavigation(targetHref, isNewTabIntent);
          }
        } else {
          pageDomainCache.set(domain, false);
          // If background worker already opened the new tab via chrome.tabs.create:
          if (response.handled) {
            return;
          }
          // Otherwise proceed with same-tab navigation
          performNavigation(targetHref, isNewTabIntent);
        }
      }
    );
  }

  /**
   * Resumes normal navigation safely without triggering Chrome's popup blocker
   */
  function performNavigation(url, newTab) {
    if (newTab) {
      // Delegate to background script which can open tabs without popup blocker restrictions
      chrome.runtime.sendMessage({ action: 'CREATE_NORMAL_TAB', url }, (res) => {
        if (chrome.runtime.lastError || !res?.success) {
          try {
            window.open(url, '_blank');
          } catch {}
        }
      });
    } else {
      window.location.assign(url);
    }
  }

  // Attach listeners at document capturing phase
  document.addEventListener('click', handleLinkClick, true);
  document.addEventListener('auxclick', handleLinkClick, true);
})();
