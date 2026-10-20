# Incognito URL Router (Chrome Extension)

A Google Chrome extension (Manifest V3) that automatically opens URLs in an Incognito tab if the website is not present in your Chrome Bookmarks or browsing history.

Designed to protect privacy seamlessly whether clicking links from external documents (Slack, Word, PDFs, Mail, Terminal) or browsing web pages in Chrome.

---

## ✨ Features

- **External Document Routing**: Clicks from desktop applications (PDF viewers, Slack, Microsoft Office, email clients, Terminal) automatically launch into an Incognito window if the destination is unfamiliar.
- **In-Page Interception**: Links clicked on web pages are pre-checked on hover and intercepted smoothly, keeping your current tab and page undisturbed while opening the link in Incognito.
- **Bookmark & History Awareness**:
  - **Domain-level Matching (Recommended)**: If `github.com` or `nytimes.com` is in your bookmarks or history, any link on that site opens normally. Only unfamiliar domains route to Incognito.
  - **Exact URL Matching (Strict)**: Toggleable setting where the exact full URL must already be visited or bookmarked.
- **Smart Window Management**: Reuses an already open Incognito window (adding a tab) or launches a new Incognito window when needed.
- **Whitelist Protection**: Add custom domains (or wildcards like `*.internal.net`) that should always open in normal tabs.
- **Live Diagnostics Tester**: Built-in test tool in Settings where you can paste any URL and see live how Chrome evaluates it against your real bookmarks and history.
- **Zero Annoyance**: Omnibox / address bar typing is not intercepted and behaves normally.

---

## 🚀 Installation Instructions

1. Open Google Chrome and navigate to `chrome://extensions` in the address bar.
2. In the top-right corner, turn ON **"Developer mode"**.
3. In the top-left corner, click **"Load unpacked"**.
4. Select the project directory:
   ```
   /Users/alan/Documents/Projects/incognito
   ```
5. **Important**: On the extension card, click **"Details"**, scroll down, and turn ON:
   - **"Allow in incognito"**
   *(Chrome requires this permission toggle for any extension to create or view Incognito tabs).*

---

## 🛠 Project Structure

```
incognito/
├── manifest.json         # Chrome Manifest V3 configuration
├── background.js         # Service worker handling external links & window management
├── content.js            # In-page click interceptor & hover prefetcher
├── lib/
│   └── matcher.js        # Core URL normalization, bookmark & history lookup engine
├── popup.html            # Browser action popup UI
├── popup.css             # Popup styling (dark theme)
├── popup.js              # Popup controller
├── options.html          # Extension options & live URL diagnostics tester
├── options.css           # Options page styling
├── options.js            # Options controller
├── icons/                # Extension icons (16px, 48px, 128px)
├── tests/
│   └── matcher.test.js   # Unit test suite
└── package.json          # Project configuration & npm test script
```

---

## 🧪 Running Tests

Run the automated test suite using Node.js built-in test runner:

```bash
npm test
```
