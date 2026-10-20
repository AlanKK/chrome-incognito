/**
 * Options and Diagnostics Controller for Incognito URL Router
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const permBadge = document.getElementById('perm-badge');
  const btnCheckPerm = document.getElementById('btn-check-perm');
  const permStatusText = document.getElementById('perm-status-text');

  const modeRadioDomain = document.getElementById('mode-radio-domain');
  const modeRadioExact = document.getElementById('mode-radio-exact');

  const chkReuseWindow = document.getElementById('chk-reuse-window');
  const chkInterceptPage = document.getElementById('chk-intercept-page');
  const chkInterceptExternal = document.getElementById('chk-intercept-external');

  const whitelistForm = document.getElementById('whitelist-form');
  const whitelistInput = document.getElementById('whitelist-input');
  const whitelistList = document.getElementById('whitelist-list');
  const whitelistEmpty = document.getElementById('whitelist-empty');

  const testerForm = document.getElementById('tester-form');
  const testerUrl = document.getElementById('tester-url');
  const testerResults = document.getElementById('tester-results');
  const testVerdict = document.getElementById('test-verdict');
  const resDomain = document.getElementById('res-domain');
  const resBookmark = document.getElementById('res-bookmark');
  const resHistory = document.getElementById('res-history');
  const resWhitelist = document.getElementById('res-whitelist');
  const resExplanation = document.getElementById('res-explanation');

  let currentSettings = {
    enabled: true,
    matchMode: 'domain',
    reuseIncognitoWindow: true,
    interceptInPageClicks: true,
    interceptExternalClicks: true,
    whitelist: []
  };

  // 1. Initial State Load
  function loadInitialState() {
    chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;

      currentSettings = { ...currentSettings, ...(response.settings || {}) };

      // Update permission status
      updatePermUI(response.incognitoAllowed);

      // Update form controls
      if (currentSettings.matchMode === 'exact') {
        modeRadioExact.checked = true;
      } else {
        modeRadioDomain.checked = true;
      }

      chkReuseWindow.checked = currentSettings.reuseIncognitoWindow !== false;
      chkInterceptPage.checked = currentSettings.interceptInPageClicks !== false;
      chkInterceptExternal.checked = currentSettings.interceptExternalClicks !== false;

      // Update whitelist
      renderWhitelist();
    });
  }

  function updatePermUI(allowed) {
    if (allowed) {
      permBadge.textContent = 'Active & Granted';
      permBadge.className = 'badge success';
      permStatusText.textContent = '✓ Extension is authorized to open Incognito tabs.';
      permStatusText.style.color = 'var(--success)';
    } else {
      permBadge.textContent = 'Action Required';
      permBadge.className = 'badge warning';
      permStatusText.textContent = '⚠ Incognito access is disabled. Follow steps above.';
      permStatusText.style.color = 'var(--warning)';
    }
  }

  btnCheckPerm.addEventListener('click', () => {
    permBadge.textContent = 'Checking...';
    permBadge.className = 'badge checking';
    chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (response) => {
      if (response) {
        updatePermUI(response.incognitoAllowed);
      }
    });
  });

  // 2. Settings Save
  function saveCurrentSettings() {
    chrome.runtime.sendMessage({
      action: 'SAVE_SETTINGS',
      settings: currentSettings
    });
  }

  modeRadioDomain.addEventListener('change', () => {
    if (modeRadioDomain.checked) {
      currentSettings.matchMode = 'domain';
      saveCurrentSettings();
    }
  });

  modeRadioExact.addEventListener('change', () => {
    if (modeRadioExact.checked) {
      currentSettings.matchMode = 'exact';
      saveCurrentSettings();
    }
  });

  chkReuseWindow.addEventListener('change', () => {
    currentSettings.reuseIncognitoWindow = chkReuseWindow.checked;
    saveCurrentSettings();
  });

  chkInterceptPage.addEventListener('change', () => {
    currentSettings.interceptInPageClicks = chkInterceptPage.checked;
    saveCurrentSettings();
  });

  chkInterceptExternal.addEventListener('change', () => {
    currentSettings.interceptExternalClicks = chkInterceptExternal.checked;
    saveCurrentSettings();
  });

  // 3. Whitelist Management
  function renderWhitelist() {
    const list = currentSettings.whitelist || [];
    whitelistList.innerHTML = '';

    if (list.length === 0) {
      whitelistEmpty.classList.remove('hidden');
      return;
    }

    whitelistEmpty.classList.add('hidden');
    list.forEach((domain, idx) => {
      const li = document.createElement('li');
      li.className = 'tag-item';
      li.innerHTML = `
        <span>${escapeHtml(domain)}</span>
        <button type="button" class="btn-remove-tag" data-index="${idx}" title="Remove domain">×</button>
      `;
      whitelistList.appendChild(li);
    });
  }

  whitelistForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const domain = whitelistInput.value.trim().toLowerCase();
    if (!domain) return;

    currentSettings.whitelist = currentSettings.whitelist || [];
    if (!currentSettings.whitelist.includes(domain)) {
      currentSettings.whitelist.push(domain);
      saveCurrentSettings();
      renderWhitelist();
    }
    whitelistInput.value = '';
  });

  whitelistList.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-remove-tag')) {
      const idx = parseInt(e.target.dataset.index, 10);
      if (!isNaN(idx)) {
        currentSettings.whitelist.splice(idx, 1);
        saveCurrentSettings();
        renderWhitelist();
      }
    }
  });

  // 4. Diagnostic URL Tester
  testerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = testerUrl.value.trim();
    if (!url) return;

    chrome.runtime.sendMessage({ action: 'TEST_URL_MATCH', url }, (response) => {
      if (chrome.runtime.lastError || !response || !response.valid) {
        testerResults.classList.remove('hidden');
        testVerdict.textContent = 'INVALID URL';
        testVerdict.className = 'verdict-badge';
        resExplanation.textContent = response?.message || 'Could not parse URL';
        return;
      }

      testerResults.classList.remove('hidden');
      resDomain.textContent = response.baseDomain || '-';

      // Bookmarks
      if (response.bookmarkMatch?.found) {
        resBookmark.textContent = `Found ("${response.bookmarkMatch.title || 'Untitled'}")`;
        resBookmark.style.color = 'var(--success)';
      } else {
        resBookmark.textContent = 'Not Found';
        resBookmark.style.color = 'var(--text-muted)';
      }

      // History
      if (response.historyMatch?.found) {
        resHistory.textContent = `Found (${response.historyMatch.visitCount || 1} visits)`;
        resHistory.style.color = 'var(--success)';
      } else {
        resHistory.textContent = 'Not Found';
        resHistory.style.color = 'var(--text-muted)';
      }

      // Whitelist
      const isWl = response.decision?.reason === 'whitelisted';
      resWhitelist.textContent = isWl ? 'Whitelisted' : 'Not on Whitelist';
      resWhitelist.style.color = isWl ? 'var(--success)' : 'var(--text-muted)';

      // Verdict
      if (response.decision?.shouldRoute) {
        testVerdict.textContent = 'ROUTES TO INCOGNITO 🕵️';
        testVerdict.className = 'verdict-badge verdict-incognito';
        resExplanation.textContent =
          `This domain (${response.baseDomain}) was not found in your bookmarks or history, so it will open in an Incognito tab.`;
      } else {
        testVerdict.textContent = 'OPENS NORMALLY IN TAB ✓';
        testVerdict.className = 'verdict-badge verdict-normal';
        let reasonText = '';
        if (response.decision?.reason === 'bookmarked') {
          reasonText = 'Matched existing bookmark.';
        } else if (response.decision?.reason === 'history') {
          reasonText = 'Found in your browsing history.';
        } else if (response.decision?.reason === 'whitelisted') {
          reasonText = 'Domain is on your custom whitelist.';
        } else {
          reasonText = response.decision?.reason || 'Known URL.';
        }
        resExplanation.textContent = `This URL will open normally in your regular browser tab (${reasonText}).`;
      }
    });
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  loadInitialState();
});
