/**
 * Popup Script for Incognito URL Router
 */

document.addEventListener('DOMContentLoaded', () => {
  const masterToggle = document.getElementById('master-toggle');
  const incognitoWarning = document.getElementById('incognito-warning');
  const btnFixIncognito = document.getElementById('btn-fix-incognito');
  const interceptCountEl = document.getElementById('intercept-count');
  const modeDomainBtn = document.getElementById('mode-domain');
  const modeExactBtn = document.getElementById('mode-exact');
  const modeDesc = document.getElementById('mode-description');
  const btnWhitelistCurrent = document.getElementById('btn-whitelist-current');
  const btnOpenOptions = document.getElementById('btn-open-options');
  const activeStatusEl = document.getElementById('active-status');

  let currentSettings = {};

  // Fetch initial state from background
  chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    currentSettings = response.settings || {};
    masterToggle.checked = currentSettings.enabled !== false;
    interceptCountEl.textContent = response.sessionInterceptCount || 0;

    // Incognito permission
    if (response.incognitoAllowed) {
      incognitoWarning.classList.add('hidden');
    } else {
      incognitoWarning.classList.remove('hidden');
    }

    // Matching mode
    setModeUI(currentSettings.matchMode || 'domain');
    updateActiveIndicator(masterToggle.checked);
  });

  function updateActiveIndicator(isActive) {
    if (isActive) {
      activeStatusEl.textContent = '● Active';
      activeStatusEl.className = 'status-indicator active';
    } else {
      activeStatusEl.textContent = '○ Disabled';
      activeStatusEl.className = 'status-indicator disabled';
    }
  }

  function setModeUI(mode) {
    if (mode === 'exact') {
      modeExactBtn.classList.add('active');
      modeDomainBtn.classList.remove('active');
      modeDesc.textContent = 'Strict: Every unvisited URL opens in Incognito, even on familiar sites.';
    } else {
      modeDomainBtn.classList.add('active');
      modeExactBtn.classList.remove('active');
      modeDesc.textContent = 'Recommended: Known domains stay in normal tabs. Only new sites open in Incognito.';
    }
  }

  // Master toggle
  masterToggle.addEventListener('change', () => {
    const enabled = masterToggle.checked;
    updateActiveIndicator(enabled);
    chrome.runtime.sendMessage({
      action: 'SAVE_SETTINGS',
      settings: { enabled }
    });
  });

  // Mode toggles
  modeDomainBtn.addEventListener('click', () => {
    setModeUI('domain');
    chrome.runtime.sendMessage({
      action: 'SAVE_SETTINGS',
      settings: { matchMode: 'domain' }
    });
  });

  modeExactBtn.addEventListener('click', () => {
    setModeUI('exact');
    chrome.runtime.sendMessage({
      action: 'SAVE_SETTINGS',
      settings: { matchMode: 'exact' }
    });
  });

  // Whitelist current site
  btnWhitelistCurrent.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return;

      const url = new URL(tab.url);
      const host = url.hostname;
      if (!host || host === 'localhost' || host === '127.0.0.1') return;

      const whitelist = currentSettings.whitelist || [];
      if (!whitelist.includes(host)) {
        whitelist.push(host);
        chrome.runtime.sendMessage({
          action: 'SAVE_SETTINGS',
          settings: { whitelist }
        }, () => {
          btnWhitelistCurrent.innerHTML = `<span>✓</span> Whitelisted ${host}`;
          setTimeout(() => {
            btnWhitelistCurrent.innerHTML = `<span class="btn-icon">🛡️</span> Whitelist Current Site`;
          }, 2000);
        });
      } else {
        btnWhitelistCurrent.innerHTML = `<span>✓</span> Already whitelisted`;
        setTimeout(() => {
          btnWhitelistCurrent.innerHTML = `<span class="btn-icon">🛡️</span> Whitelist Current Site`;
        }, 1500);
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Fix incognito permission
  btnFixIncognito.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Open options
  btnOpenOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
