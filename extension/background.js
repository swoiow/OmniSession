importScripts("i18n.js");

const API_BASE = "http://localhost:8000";
const API_BASE_KEY = "apiBase";
const API_PASSWORD_KEY = "apiPassword";
const DEBUG_LOGS_KEY = "debugLogs";
const TAB_LOAD_TIMEOUT_MS = 12000;

let debugLogsEnabled = false;

function debugLog(message, payload = null) {
  if (!debugLogsEnabled) {
    return;
  }
  if (payload === null) {
    console.log(message);
    return;
  }
  console.log(message, payload);
}

function getRootDomain(url) {
  const hostname = new URL(url).hostname;
  const parts = hostname.split(".");
  if (parts.length > 2) {
    return parts.slice(-2).join(".");
  }
  return hostname;
}

function isRestrictedUrl(url) {
  return (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("edge://")
  );
}

function chromePromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });
}

async function loadDebugLogsSetting() {
  try {
    const data = await chromePromise(
        chrome.storage.local.get.bind(chrome.storage.local),
        [DEBUG_LOGS_KEY]
    );
    debugLogsEnabled = Boolean(data[DEBUG_LOGS_KEY]);
  } catch (error) {
    debugLogsEnabled = false;
  }
}

async function getActiveTab() {
  const tabs = await chromePromise(chrome.tabs.query, {
    active: true,
    currentWindow: true,
  });
  return tabs[0];
}

async function getApiBase() {
  const data = await chromePromise(
      chrome.storage.local.get.bind(chrome.storage.local),
      [API_BASE_KEY]
  );
  return data[API_BASE_KEY] || API_BASE;
}

async function getApiPassword() {
  const data = await chromePromise(
      chrome.storage.local.get.bind(chrome.storage.local),
      [API_PASSWORD_KEY]
  );
  return data[API_PASSWORD_KEY] || "";
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Tab load timeout"));
    }, TAB_LOAD_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        cleanup();
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chromePromise(chrome.tabs.get, tabId)
        .then((tab) => {
          if (tab.status === "complete") {
            cleanup();
            resolve();
          }
        })
        .catch(() => {
        });
  });
}

async function readLocalStorage(tabId) {
  const results = await chromePromise(chrome.scripting.executeScript, {
    target: {tabId},
    func: () => {
      const data = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null) {
          data[key] = localStorage.getItem(key);
        }
      }
      return data;
    },
  });
  if (!results || results.length === 0) {
    return {};
  }
  return results[0].result || {};
}

async function writeLocalStorage(tabId, payload) {
  await chromePromise(chrome.scripting.executeScript, {
    target: {tabId},
    args: [payload],
    func: (data) => {
      localStorage.clear();
      Object.entries(data).forEach(([key, value]) => {
        localStorage.setItem(key, String(value));
      });
    },
  });
}

async function readLocalStorageForUrl(url) {
  let tab = null;
  try {
    tab = await chromePromise(chrome.tabs.create, {url, active: false});
    await waitForTabLoad(tab.id);
    const currentTab = await chromePromise(chrome.tabs.get, tab.id);
    if (!currentTab.url || isRestrictedUrl(currentTab.url)) {
      throw new Error(
          USK_I18N.t("error_unsupported_page", {
            action: USK_I18N.t("action_storage"),
          })
      );
    }
    const data = await readLocalStorage(tab.id);
    const origin = new URL(currentTab.url).origin;
    return {origin, data};
  } finally {
    if (tab) {
      await chromePromise(chrome.tabs.remove, tab.id);
    }
  }
}

async function writeLocalStorageForUrl(origin, payload) {
  let tab = null;
  try {
    tab = await chromePromise(chrome.tabs.create, {url: origin, active: false});
    await waitForTabLoad(tab.id);
    const currentTab = await chromePromise(chrome.tabs.get, tab.id);
    if (!currentTab.url || isRestrictedUrl(currentTab.url)) {
      throw new Error(
          USK_I18N.t("error_unsupported_page", {
            action: USK_I18N.t("action_storage"),
          })
      );
    }
    await writeLocalStorage(tab.id, payload);
  } finally {
    if (tab) {
      await chromePromise(chrome.tabs.remove, tab.id);
    }
  }
}

function collectCandidateHosts(cookies, currentHostname) {
  const hosts = new Set([currentHostname]);
  cookies.forEach((cookie) => {
    if (!cookie.domain) {
      return;
    }
    const host = cookie.domain.replace(/^\./, "");
    if (host) {
      hosts.add(host);
    }
  });
  return Array.from(hosts);
}

function mergeCookies(...cookieLists) {
  const merged = new Map();
  cookieLists.flat().forEach((cookie) => {
    if (!cookie || !cookie.name) {
      return;
    }
    const key = `${cookie.name}|${cookie.domain || ""}|${cookie.path || ""}`;
    if (!merged.has(key)) {
      merged.set(key, cookie);
    }
  });
  return Array.from(merged.values());
}

function filterCookiesForDomain(cookies, rootDomain, currentHostname) {
  return cookies.filter((cookie) => {
    const cookieDomain = cookie.domain ? cookie.domain.replace(/^\./, "") : "";
    if (!cookieDomain) {
      return false;
    }
    if (cookieDomain === currentHostname || cookieDomain === rootDomain) {
      return true;
    }
    return cookieDomain.endsWith(`.${rootDomain}`);
  });
}

async function runBackup() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    throw new Error(USK_I18N.t("error_no_active_tab"));
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
        USK_I18N.t("error_unsupported_page", {
          action: USK_I18N.t("action_backup"),
        })
    );
  }

  const rootDomain = getRootDomain(tab.url);
  const currentUrl = new URL(tab.url);
  const currentOrigin = currentUrl.origin;
  const currentHostname = currentUrl.hostname;
  debugLog("[USK] Backup start", {url: tab.url, rootDomain});
  let storeId = null;
  try {
    const stores = await chromePromise(chrome.cookies.getAllCookieStores);
    const store = stores.find((item) => item.tabIds.includes(tab.id));
    storeId = store ? store.id : null;
    debugLog("[USK] Cookie store", {storeId});
  } catch (error) {
    storeId = null;
    debugLog("[USK] Cookie store lookup failed");
  }

  const cookieQueries = [
    {label: "domain", query: {domain: rootDomain}},
    {label: "url", query: {url: tab.url}},
    {label: "origin", query: {url: currentOrigin}},
    {label: "origin-slash", query: {url: `${currentOrigin}/`}},
  ];
  const cookieBuckets = [];
  for (const {label, query} of cookieQueries) {
    const queryWithStore = storeId ? {...query, storeId} : query;
    const result = await chromePromise(chrome.cookies.getAll, queryWithStore);
    debugLog("[USK] Cookies by query", {label, count: result.length});
    cookieBuckets.push(result);
  }

  let cookies = mergeCookies(...cookieBuckets);
  debugLog("[USK] Cookies merged", {count: cookies.length});

  if (cookies.length === 0) {
    const allQuery = storeId ? {storeId} : {};
    const allCookies = await chromePromise(chrome.cookies.getAll, allQuery);
    cookies = mergeCookies(
        cookies,
        filterCookiesForDomain(allCookies, rootDomain, currentHostname)
    );
    debugLog("[USK] Cookies fallback", {
      total: allCookies.length,
      filtered: cookies.length,
    });
  }
  const localStorageData = await readLocalStorage(tab.id);
  const localStorageMap = {
    [currentOrigin]: localStorageData,
  };

  const candidateHosts = collectCandidateHosts(cookies, currentHostname);
  for (const host of candidateHosts) {
    if (host === currentHostname) {
      continue;
    }
    let result = null;
    try {
      result = await readLocalStorageForUrl(`https://${host}`);
    } catch (error) {
      try {
        result = await readLocalStorageForUrl(`http://${host}`);
      } catch (httpError) {
        result = null;
      }
    }
    if (result && result.origin && !localStorageMap[result.origin]) {
      localStorageMap[result.origin] = result.data;
    }
  }

  const apiBase = await getApiBase();
  const apiPassword = await getApiPassword();
  const headers = {"Content-Type": "application/json"};
  if (apiPassword) {
    headers["X-USK-Password"] = apiPassword;
  }
  debugLog("[USK] Backup payload", {
    apiBase,
    domain: rootDomain,
    cookies: cookies.length,
    localStorageOrigins: Object.keys(localStorageMap).length,
  });
  const response = await fetch(`${apiBase}/backup`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      domain: rootDomain,
      cookies,
      local_storage: localStorageMap,
    }),
  });

  if (!response.ok) {
    throw new Error(
        USK_I18N.t("error_backup_failed", {status: response.status})
    );
  }

  return {domain: rootDomain, cookies: cookies.length};
}

function buildCookieDetails(cookie, storeId) {
  const hostname = cookie.domain.replace(/^\./, "");
  const url = `${cookie.secure ? "https" : "http"}://${hostname}${
      cookie.path || "/"
  }`;
  const details = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  if (!cookie.hostOnly) {
    details.domain = cookie.domain;
  }
  if (storeId) {
    details.storeId = storeId;
  }

  if (cookie.sameSite !== undefined) {
    details.sameSite = cookie.sameSite;
  }
  if (typeof cookie.expirationDate === "number") {
    details.expirationDate = cookie.expirationDate;
  }
  if (cookie.priority) {
    details.priority = cookie.priority;
  }
  if (cookie.sameParty !== undefined) {
    details.sameParty = cookie.sameParty;
  }

  return details;
}

async function getCookieStoreIdForTab(tabId) {
  try {
    const stores = await chromePromise(chrome.cookies.getAllCookieStores);
    const store = stores.find((item) => item.tabIds.includes(tabId));
    return store ? store.id : null;
  } catch (error) {
    return null;
  }
}

async function runRestore() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    throw new Error(USK_I18N.t("error_no_active_tab"));
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
        USK_I18N.t("error_unsupported_page", {
          action: USK_I18N.t("action_restore"),
        })
    );
  }

  const rootDomain = getRootDomain(tab.url);
  const apiBase = await getApiBase();
  const apiPassword = await getApiPassword();
  const headers = {};
  if (apiPassword) {
    headers["X-USK-Password"] = apiPassword;
  }
  const response = await fetch(
      `${apiBase}/restore/${encodeURIComponent(rootDomain)}`,
      {headers}
  );
  if (!response.ok) {
    if (response.status === 401) {
      const data = await response.json().catch(() => null);
      if (data && data.detail === "Password required") {
        throw new Error(USK_I18N.t("error_password_required"));
      }
      if (data && data.detail === "Invalid password") {
        throw new Error(USK_I18N.t("error_invalid_password"));
      }
    }
    throw new Error(
        USK_I18N.t("error_restore_failed", {status: response.status})
    );
  }

  const data = await response.json();
  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  const storeId = await getCookieStoreIdForTab(tab.id);

  await Promise.all(
      cookies.map((cookie) =>
          chromePromise(chrome.cookies.set, buildCookieDetails(cookie, storeId))
      )
  );

  const localStorageMap = data.local_storage || {};
  const currentOrigin = new URL(tab.url).origin;
  if (localStorageMap[currentOrigin]) {
    await writeLocalStorage(tab.id, localStorageMap[currentOrigin]);
  }

  const otherOrigins = Object.keys(localStorageMap).filter(
      (origin) => origin !== currentOrigin
  );
  for (const origin of otherOrigins) {
    try {
      await writeLocalStorageForUrl(origin, localStorageMap[origin]);
    } catch (error) {
      // Best-effort: ignore per-origin failures.
    }
  }
  await chromePromise(chrome.tabs.reload, tab.id);

  return {domain: rootDomain, cookies: cookies.length};
}

async function runDelete() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    throw new Error(USK_I18N.t("error_no_active_tab"));
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
        USK_I18N.t("error_unsupported_page", {
          action: USK_I18N.t("action_delete"),
        })
    );
  }

  const rootDomain = getRootDomain(tab.url);
  const apiBase = await getApiBase();
  const response = await fetch(
      `${apiBase}/backup/${encodeURIComponent(rootDomain)}`,
      {method: "DELETE"}
  );

  if (!response.ok) {
    throw new Error(
        USK_I18N.t("error_delete_failed", {status: response.status})
    );
  }

  const data = await response.json().catch(() => ({}));
  return {domain: rootDomain, deleted: Boolean(data.deleted)};
}

async function runCheck() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    throw new Error(USK_I18N.t("error_no_active_tab"));
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
        USK_I18N.t("error_unsupported_page", {
          action: USK_I18N.t("action_status"),
        })
    );
  }

  const apiBase = await getApiBase();
  let backendOk = false;
  try {
    const response = await fetch(`${apiBase}/`);
    backendOk = response.ok;
  } catch (error) {
    backendOk = false;
  }

  const rootDomain = getRootDomain(tab.url);
  if (!backendOk) {
    return {backendOk: false, domain: rootDomain, hasBackup: false, updatedAt: null};
  }

  try {
    const response = await fetch(`${apiBase}/status/${encodeURIComponent(rootDomain)}`);
    if (!response.ok) {
      return {backendOk: true, domain: rootDomain, hasBackup: false, updatedAt: null};
    }
    const data = await response.json();
    return {
      backendOk: true,
      domain: rootDomain,
      hasBackup: Boolean(data.exists),
      updatedAt: data.updated_at || null,
    };
  } catch (error) {
    return {backendOk: true, domain: rootDomain, hasBackup: false, updatedAt: null};
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ok: false, error: "Unknown command"});
    return false;
  }

  let handler = null;
  if (message.type === "backup") {
    handler = runBackup;
  } else if (message.type === "restore") {
    handler = runRestore;
  } else if (message.type === "delete") {
    handler = runDelete;
  } else if (message.type === "check") {
    handler = runCheck;
  }
  if (!handler) {
    sendResponse({ok: false, error: "Unknown command"});
    return false;
  }

  handler()
      .then((result) => {
        sendResponse({ok: true, result});
      })
      .catch((error) => {
        sendResponse({ok: false, error: error.message || String(error)});
      });

  return true;
});

loadDebugLogsSetting();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[DEBUG_LOGS_KEY]) {
    debugLogsEnabled = Boolean(changes[DEBUG_LOGS_KEY].newValue);
  }
  if (changes[USK_I18N.LANG_KEY]) {
    USK_I18N.init(changes[USK_I18N.LANG_KEY].newValue).catch(() => {
    });
  }
});

USK_I18N.init().catch(() => {
});
