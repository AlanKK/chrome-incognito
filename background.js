/**
 * Background Service Worker for Incognito URL Router
 * Coordinates settings, caching, in-page interception, and external document link routing.
 */

import {
  parseUrl,
  isWebUrl,
  isInternalOrIgnoredUrl,
  getBaseDomain,
  checkBookmarks,
  checkHistory,
  shouldRouteToIncognito
} from './lib/matcher.js';

export const DEFAULT_SETTINGS = {
  enabled: true,
  matchMode: 'domain', // 'domain' | 'exact'
  reuseIncognitoWindow: true,
  interceptInPageClicks: true,
  interceptExternalClicks: true,
  whitelist: []
};

// Global state
let currentSettings = { ...DEFAULT_SETTINGS };
const decisionCache = new Map();
const CACHE_MAX_SIZE = 1000;
let sessionInterceptCount = 0;

// Tracks tabs created by external applications awaiting their destination URL
const pendingExternalTabs = new Map();

/**
 * Loads settings from chrome.storage.local
 */
async function loadSettings() {
  try {
    const data = await chrome.storage.local.get('settings');
    if (data && data.settings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...data.settings };
    } else {
      await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

// Invalidate or trim cache
function clearCache() {
  decisionCache.clear();
}

function addToCache(key, value) {
  if (decisionCache.size >= CACHE_MAX_SIZE) {
    const firstKey = decisionCache.keys().next().value;
    decisionCache.delete(firstKey);
  }
  decisionCache.set(key, value);
}

/**
 * Checks if the extension has Incognito access granted by the user.
 * @returns {Promise<boolean>}
 */
export async function checkIncognitoAllowed() {
  return new Promise((resolve) => {
    if (chrome.extension && typeof chrome.extension.isAllowedIncognitoAccess === 'function') {
      chrome.extension.isAllowedIncognitoAccess(resolve);
    } else {
      resolve(false);
    }
  });
}

/**
 * Opens a URL in an Incognito window or tab.
 * @param {string} url
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function openInIncognito(url) {
  const allowed = await checkIncognitoAllowed();
  if (!allowed) {
    console.warn('Cannot open in incognito: "Allow in Incognito" is not enabled in chrome://extensions');
    return { success: false, error: 'NO_INCOGNITO_ACCESS' };
  }

  try {
    if (currentSettings.reuseIncognitoWindow) {
      // Look for an existing incognito window
      const windows = await chrome.windows.getAll({ populate: false, windowTypes: ['normal'] });
      const incognitoWindow = windows.find((w) => w.incognito);

      if (incognitoWindow) {
        await chrome.tabs.create({
          windowId: incognitoWindow.id,
          url,
          active: true
        });
        await chrome.windows.update(incognitoWindow.id, { focused: true });
        sessionInterceptCount++;
        return { success: true };
      }
    }

    // Create a new incognito window
    await chrome.windows.create({
      url,
      incognito: true,
      focused: true
    });
    sessionInterceptCount++;
    return { success: true };
  } catch (err) {
    console.error('Failed to open incognito window:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Evaluates whether a URL should route to incognito using active Chrome APIs
 * @param {string} targetUrl
 * @returns {Promise<{ shouldRoute: boolean, reason: string, details?: object }>}
 */
export async function evaluateUrl(targetUrl) {
  return shouldRouteToIncognito(targetUrl, {
    bookmarksApi: chrome.bookmarks,
    historyApi: chrome.history,
    settings: currentSettings,
    cache: decisionCache
  });
}

// -------------------------------------------------------------
// EXTERNAL DOCUMENT NAVIGATION INTERCEPTION
// -------------------------------------------------------------

/**
 * Handles tabs created without an openerTabId (typically from external desktop apps)
 */
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!currentSettings.enabled || !currentSettings.interceptExternalClicks) return;
  if (tab.incognito) return; // Already in incognito

  // External links have no openerTabId
  if (tab.openerTabId === undefined) {
    const candidateUrl = tab.pendingUrl || tab.url;

    if (candidateUrl && isWebUrl(candidateUrl)) {
      await handleExternalNavigation(tab.id, candidateUrl);
    } else {
      // Store tabId to watch for its first URL in onUpdated or onBeforeNavigate
      pendingExternalTabs.set(tab.id, { timestamp: Date.now() });

      // Clean up after 6 seconds to avoid leaking memory
      setTimeout(() => {
        pendingExternalTabs.delete(tab.id);
      }, 6000);
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingExternalTabs.has(tabId)) return;
  if (!currentSettings.enabled || !currentSettings.interceptExternalClicks) return;
  if (tab.incognito) return;

  const candidateUrl = changeInfo.url || tab.pendingUrl || tab.url;
  if (candidateUrl && isWebUrl(candidateUrl)) {
    pendingExternalTabs.delete(tabId);
    await handleExternalNavigation(tabId, candidateUrl);
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!pendingExternalTabs.has(details.tabId)) return;
  if (!currentSettings.enabled || !currentSettings.interceptExternalClicks) return;

  if (isWebUrl(details.url)) {
    pendingExternalTabs.delete(details.tabId);
    await handleExternalNavigation(details.tabId, details.url);
  }
});

/**
 * Processes an external document navigation request
 */
async function handleExternalNavigation(tabId, url) {
  try {
    const decision = await evaluateUrl(url);

    if (decision.shouldRoute) {
      console.log(`[Incognito URL Router] External link routed to incognito: ${url}`);
      
      // 1. Open in incognito window
      const openResult = await openInIncognito(url);

      if (openResult.success) {
        // 2. Remove the empty/dummy tab created in the normal window
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // Tab might have already been closed
        }

        // 3. Remove visit from normal history if Chrome recorded it
        try {
          await chrome.history.deleteUrl({ url });
        } catch {
          // Ignore
        }
      }
    }
  } catch (err) {
    console.error('Error handling external navigation:', err);
  }
}

// -------------------------------------------------------------
// IN-PAGE CLICK INTERCEPTION & EXTENSION MESSAGING
// -------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  (async () => {
    switch (message.action) {
      case 'CHECK_URL': {
        const decision = await evaluateUrl(message.url);
        sendResponse(decision);
        break;
      }

      case 'OPEN_INCOGNITO': {
        const result = await openInIncognito(message.url);
        sendResponse(result);
        break;
      }

      case 'CHECK_AND_ROUTE_LINK': {
        if (!currentSettings.enabled || !currentSettings.interceptInPageClicks) {
          sendResponse({ shouldRoute: false, reason: 'disabled' });
          return;
        }

        const decision = await evaluateUrl(message.url);
        if (decision.shouldRoute) {
          const openResult = await openInIncognito(message.url);
          sendResponse({ shouldRoute: true, openResult });
        } else {
          sendResponse({ shouldRoute: false, reason: decision.reason });
        }
        break;
      }

      case 'GET_STATUS': {
        const incognitoAllowed = await checkIncognitoAllowed();
        sendResponse({
          settings: currentSettings,
          incognitoAllowed,
          sessionInterceptCount
        });
        break;
      }

      case 'SAVE_SETTINGS': {
        currentSettings = { ...currentSettings, ...message.settings };
        await chrome.storage.local.set({ settings: currentSettings });
        clearCache();
        sendResponse({ success: true, settings: currentSettings });
        break;
      }

      case 'TEST_URL_MATCH': {
        // Live URL tester for options page
        const url = message.url;
        const parsed = parseUrl(url);
        if (!parsed || isInternalOrIgnoredUrl(parsed)) {
          sendResponse({
            valid: false,
            message: 'Invalid or internal URL (cannot be routed)'
          });
          return;
        }

        const mode = currentSettings.matchMode || 'domain';
        const bookmarkRes = await checkBookmarks(url, chrome.bookmarks, mode);
        const historyRes = await checkHistory(url, chrome.history, mode);
        const decision = await evaluateUrl(url);

        sendResponse({
          valid: true,
          url,
          mode,
          baseDomain: getBaseDomain(parsed.hostname),
          bookmarkMatch: bookmarkRes,
          historyMatch: historyRes,
          decision
        });
        break;
      }

      default:
        sendResponse({ error: 'Unknown action' });
    }
  })();

  return true; // Keep channel open for async response
});

// -------------------------------------------------------------
// CACHE INVALIDATION & SETTINGS SYNC
// -------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    clearCache();
  }
});

// Invalidate cache when bookmarks or history change
chrome.bookmarks.onCreated.addListener(clearCache);
chrome.bookmarks.onRemoved.addListener(clearCache);
chrome.bookmarks.onChanged.addListener(clearCache);
chrome.history.onVisited.addListener(clearCache);

// -------------------------------------------------------------
// ONBOARDING & INSTALLATION
// -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();

  const incognitoAllowed = await checkIncognitoAllowed();
  if (!incognitoAllowed) {
    // Open options page with onboarding prompt
    chrome.runtime.openOptionsPage();
  }
});

// Initial boot
loadSettings();
