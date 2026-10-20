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

// Global tracking to prevent duplicate processing of the same tab navigation
const handledTabs = new Set();

/**
 * Checks if the extension has Incognito access granted by the user.
 * @returns {Promise<boolean>}
 */
export async function checkIncognitoAllowed() {
  try {
    if (chrome.extension && typeof chrome.extension.isAllowedIncognitoAccess === 'function') {
      return await chrome.extension.isAllowedIncognitoAccess();
    }
  } catch (err) {
    console.warn('Error checking isAllowedIncognitoAccess:', err);
  }
  return false;
}

/**
 * Opens a URL in an Incognito window or tab.
 * Directly attempts creation with proper try-catch error handling.
 * @param {string} url
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function openInIncognito(url) {
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
    const isPermissionError = String(err).toLowerCase().includes('incognito');
    return {
      success: false,
      error: isPermissionError ? 'NO_INCOGNITO_ACCESS' : (err.message || String(err))
    };
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

function notifyMissingIncognitoPermission() {
  try {
    chrome.runtime.openOptionsPage();
  } catch {
    // Ignore
  }
}

/**
 * Processes an external document or new tab navigation request
 */
async function handleExternalOrNewTabNavigation(tabId, url) {
  try {
    const decision = await evaluateUrl(url);

    if (decision.shouldRoute) {
      console.log(`[Incognito URL Router] Routing unfamiliar link to incognito: ${url}`);
      const openResult = await openInIncognito(url);

      if (openResult.success) {
        // Remove the dummy tab created in the normal window
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // Tab might have already been closed
        }

        // Remove visit from normal history if Chrome recorded it
        try {
          await chrome.history.deleteUrl({ url });
        } catch {
          // Ignore
        }
      } else if (openResult.error === 'NO_INCOGNITO_ACCESS') {
        notifyMissingIncognitoPermission();
      }
    }
  } catch (err) {
    console.error('Error handling external or new tab navigation:', err);
  }
}

// -------------------------------------------------------------
// EXTERNAL DOCUMENT & NEW TAB NAVIGATION INTERCEPTION
// -------------------------------------------------------------

// Catch targets created specifically for navigation (external opens, target="_blank", middle click)
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  if (!currentSettings.enabled || !currentSettings.interceptExternalClicks) return;
  if (handledTabs.has(details.tabId)) return;

  if (details.url && isWebUrl(details.url)) {
    handledTabs.add(details.tabId);
    setTimeout(() => handledTabs.delete(details.tabId), 10000);
    await handleExternalOrNewTabNavigation(details.tabId, details.url);
  }
});

// Catch newly created tabs from desktop applications
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!currentSettings.enabled || !currentSettings.interceptExternalClicks) return;
  if (tab.incognito) return;
  if (handledTabs.has(tab.id)) return;

  if (tab.openerTabId === undefined) {
    const candidateUrl = tab.pendingUrl || tab.url;

    if (candidateUrl && isWebUrl(candidateUrl)) {
      handledTabs.add(tab.id);
      setTimeout(() => handledTabs.delete(tab.id), 10000);
      await handleExternalOrNewTabNavigation(tab.id, candidateUrl);
    } else {
      pendingExternalTabs.set(tab.id, { timestamp: Date.now() });
      setTimeout(() => pendingExternalTabs.delete(tab.id), 8000);
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingExternalTabs.has(tabId)) return;
  if (!currentSettings.enabled || !currentSettings.interceptExternalClicks) return;
  if (tab.incognito || handledTabs.has(tabId)) return;

  const candidateUrl = changeInfo.url || tab.pendingUrl || tab.url;
  if (candidateUrl && isWebUrl(candidateUrl)) {
    pendingExternalTabs.delete(tabId);
    handledTabs.add(tabId);
    setTimeout(() => handledTabs.delete(tabId), 10000);
    await handleExternalOrNewTabNavigation(tabId, candidateUrl);
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!currentSettings.enabled || !currentSettings.interceptExternalClicks) return;
  if (handledTabs.has(details.tabId)) return;

  if (pendingExternalTabs.has(details.tabId)) {
    pendingExternalTabs.delete(details.tabId);
    if (isWebUrl(details.url)) {
      handledTabs.add(details.tabId);
      setTimeout(() => handledTabs.delete(details.tabId), 10000);
      await handleExternalOrNewTabNavigation(details.tabId, details.url);
    }
    return;
  }

  // Check if this tab is an external link launch whose onCreated event was delayed
  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (tab && !tab.incognito && tab.openerTabId === undefined && isWebUrl(details.url)) {
      handledTabs.add(details.tabId);
      setTimeout(() => handledTabs.delete(details.tabId), 10000);
      await handleExternalOrNewTabNavigation(details.tabId, details.url);
    }
  } catch {
    // Tab might not be accessible
  }
});

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

async function injectContentScriptIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id && !tab.incognito) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }).catch(() => {
          // Ignore tabs where script injection is prohibited (e.g. Chrome Web Store)
        });
      }
    }
  } catch (err) {
    console.warn('Could not inject content scripts into existing tabs:', err);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();
  await injectContentScriptIntoExistingTabs();

  const incognitoAllowed = await checkIncognitoAllowed();
  if (!incognitoAllowed) {
    // Open options page with onboarding prompt
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  await injectContentScriptIntoExistingTabs();
});

// Initial boot
loadSettings();
injectContentScriptIntoExistingTabs();

