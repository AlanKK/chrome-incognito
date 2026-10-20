import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUrl,
  isWebUrl,
  isInternalOrIgnoredUrl,
  getBaseDomain,
  isWhitelisted,
  checkBookmarks,
  checkHistory,
  shouldRouteToIncognito
} from '../lib/matcher.js';

test('getBaseDomain handles standard and multi-part TLDs', () => {
  assert.equal(getBaseDomain('example.com'), 'example.com');
  assert.equal(getBaseDomain('sub.example.com'), 'example.com');
  assert.equal(getBaseDomain('deep.sub.example.com'), 'example.com');
  assert.equal(getBaseDomain('bbc.co.uk'), 'bbc.co.uk');
  assert.equal(getBaseDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(getBaseDomain('gov.au'), 'gov.au');
  assert.equal(getBaseDomain('dept.gov.au'), 'dept.gov.au');
  assert.equal(getBaseDomain('localhost'), 'localhost');
  assert.equal(getBaseDomain('127.0.0.1'), '127.0.0.1');
});

test('isWebUrl and isInternalOrIgnoredUrl correctly identify valid web URLs and system URLs', () => {
  assert.equal(isWebUrl('https://example.com/page'), true);
  assert.equal(isWebUrl('http://example.org'), true);
  assert.equal(isWebUrl('chrome://extensions'), false);
  assert.equal(isWebUrl('about:blank'), false);
  assert.equal(isWebUrl('file:///Users/alan/doc.pdf'), false);

  assert.equal(isInternalOrIgnoredUrl('chrome://settings'), true);
  assert.equal(isInternalOrIgnoredUrl('about:blank'), true);
  assert.equal(isInternalOrIgnoredUrl('http://localhost:3000'), true);
  assert.equal(isInternalOrIgnoredUrl('http://127.0.0.1:8080'), true);
  assert.equal(isInternalOrIgnoredUrl('https://mydev.local'), true);
  assert.equal(isInternalOrIgnoredUrl('https://github.com'), false);
});

test('isWhitelisted checks exact and wildcard matches', () => {
  const whitelist = ['google.com', '*.apple.com', 'internal.net'];
  assert.equal(isWhitelisted('google.com', whitelist), true);
  assert.equal(isWhitelisted('mail.google.com', whitelist), true);
  assert.equal(isWhitelisted('developer.apple.com', whitelist), true);
  assert.equal(isWhitelisted('apple.com', whitelist), true);
  assert.equal(isWhitelisted('internal.net', whitelist), true);
  assert.equal(isWhitelisted('evilapple.com', whitelist), false);
  assert.equal(isWhitelisted('facebook.com', whitelist), false);
});

test('checkBookmarks finds matching bookmarks by domain or exact URL', async () => {
  const mockBookmarksApi = {
    search: (query, callback) => {
      const db = [
        { title: 'GitHub', url: 'https://github.com/alan' },
        { title: 'BBC News', url: 'https://news.bbc.co.uk/world' }
      ];
      if (typeof query === 'object' && query.url) {
        callback(db.filter((b) => b.url === query.url));
      } else {
        const q = String(query).toLowerCase();
        callback(db.filter((b) => b.url.toLowerCase().includes(q) || b.title.toLowerCase().includes(q)));
      }
    }
  };

  // Domain match
  const res1 = await checkBookmarks('https://github.com/someone/repo', mockBookmarksApi, 'domain');
  assert.equal(res1.found, true);

  const res2 = await checkBookmarks('https://bbc.co.uk/sport', mockBookmarksApi, 'domain');
  assert.equal(res2.found, true);

  const res3 = await checkBookmarks('https://unfamiliar-site.org', mockBookmarksApi, 'domain');
  assert.equal(res3.found, false);

  // Exact match
  const exactFound = await checkBookmarks('https://github.com/alan', mockBookmarksApi, 'exact');
  assert.equal(exactFound.found, true);

  const exactNotFound = await checkBookmarks('https://github.com/someone/repo', mockBookmarksApi, 'exact');
  assert.equal(exactNotFound.found, false);
});

test('checkHistory finds matching history by domain or exact URL', async () => {
  const mockHistoryApi = {
    search: ({ text }, callback) => {
      const historyItems = [
        { url: 'https://stackoverflow.com/questions/12345', visitCount: 5 },
        { url: 'https://docs.python.org/3/library', visitCount: 12 }
      ];
      const q = String(text).toLowerCase();
      callback(historyItems.filter((h) => h.url.toLowerCase().includes(q)));
    },
    getVisits: ({ url }, callback) => {
      if (url === 'https://stackoverflow.com/questions/12345') {
        callback([{ visitTime: 123456789 }]);
      } else {
        callback([]);
      }
    }
  };

  // Domain match
  const res1 = await checkHistory('https://stackoverflow.com/a/9999', mockHistoryApi, 'domain');
  assert.equal(res1.found, true);

  const res2 = await checkHistory('https://unknown-blog.xyz/post', mockHistoryApi, 'domain');
  assert.equal(res2.found, false);

  // Exact match
  const exactFound = await checkHistory('https://stackoverflow.com/questions/12345', mockHistoryApi, 'exact');
  assert.equal(exactFound.found, true);

  const exactNotFound = await checkHistory('https://stackoverflow.com/questions/other', mockHistoryApi, 'exact');
  assert.equal(exactNotFound.found, false);
});

test('shouldRouteToIncognito accurately makes routing decisions', async () => {
  const mockBookmarksApi = {
    search: (query, callback) => {
      if (typeof query === 'string' && query.includes('bookmarked-site')) {
        callback([{ title: 'Bookmarked', url: 'https://bookmarked-site.com' }]);
      } else {
        callback([]);
      }
    }
  };

  const mockHistoryApi = {
    search: ({ text }, callback) => {
      if (text.includes('visited-site')) {
        callback([{ url: 'https://visited-site.com/home', visitCount: 2 }]);
      } else {
        callback([]);
      }
    },
    getVisits: () => []
  };

  const cache = new Map();

  // 1. Ignored internal URL
  const internal = await shouldRouteToIncognito('chrome://settings', {
    bookmarksApi: mockBookmarksApi,
    historyApi: mockHistoryApi,
    cache
  });
  assert.equal(internal.shouldRoute, false);
  assert.equal(internal.reason, 'internal_or_ignored');

  // 2. Bookmarked site
  const bookmarked = await shouldRouteToIncognito('https://bookmarked-site.com/article/1', {
    bookmarksApi: mockBookmarksApi,
    historyApi: mockHistoryApi,
    cache
  });
  assert.equal(bookmarked.shouldRoute, false);
  assert.equal(bookmarked.reason, 'bookmarked');

  // 3. History site
  const visited = await shouldRouteToIncognito('https://visited-site.com/profile', {
    bookmarksApi: mockBookmarksApi,
    historyApi: mockHistoryApi,
    cache
  });
  assert.equal(visited.shouldRoute, false);
  assert.equal(visited.reason, 'history');

  // 4. Unknown site -> should route to incognito
  const unknown = await shouldRouteToIncognito('https://brand-new-site-never-visited.com', {
    bookmarksApi: mockBookmarksApi,
    historyApi: mockHistoryApi,
    cache
  });
  assert.equal(unknown.shouldRoute, true);
  assert.equal(unknown.reason, 'unvisited_unbookmarked');

  // 5. Whitelisted site
  const whitelisted = await shouldRouteToIncognito('https://whitelisted-site.com', {
    bookmarksApi: mockBookmarksApi,
    historyApi: mockHistoryApi,
    settings: { whitelist: ['whitelisted-site.com'] },
    cache
  });
  assert.equal(whitelisted.shouldRoute, false);
  assert.equal(whitelisted.reason, 'whitelisted');

  // 6. Extension disabled
  const disabled = await shouldRouteToIncognito('https://brand-new-site-never-visited.com', {
    bookmarksApi: mockBookmarksApi,
    historyApi: mockHistoryApi,
    settings: { enabled: false },
    cache
  });
  assert.equal(disabled.shouldRoute, false);
  assert.equal(disabled.reason, 'extension_disabled');
});
