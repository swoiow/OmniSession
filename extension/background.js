importScripts("i18n.js");

const API_BASE = "http://localhost:8000";
const API_BASE_KEY = "apiBase";
const API_PASSWORD_KEY = "apiPassword";
const USER_ID_KEY = "userId";
const DEBUG_LOGS_KEY = "debugLogs";
const TAB_LOAD_TIMEOUT_MS = 12000;
const E2E_PREFIX = "/e2e";
const COOKIE_SIZE_LIMIT_BYTES = 6 * 1024;
const KDF_ITERATIONS = 200000;
const KDF_SALT_BYTES = 16;
const KDF_NONCE_BYTES = 12;

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

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: KDF_ITERATIONS,
        hash: "SHA-256",
      },
      keyMaterial,
      {name: "AES-GCM", length: 256},
      false,
      ["encrypt", "decrypt"]
  );
}

async function encryptE2EPayload(payload, password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(KDF_NONCE_BYTES));
  const key = await deriveKey(password, salt);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
      {name: "AES-GCM", iv: nonce},
      key,
      plaintext
  );
  return {
    payload: bytesToBase64(new Uint8Array(ciphertext)),
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
  };
}

async function decryptE2EPayload(payload, salt, nonce, password) {
  const decoder = new TextDecoder();
  const saltBytes = base64ToBytes(salt);
  const nonceBytes = base64ToBytes(nonce);
  const key = await deriveKey(password, saltBytes);
  const plaintext = await crypto.subtle.decrypt(
      {name: "AES-GCM", iv: nonceBytes},
      key,
      base64ToBytes(payload)
  );
  return JSON.parse(decoder.decode(new Uint8Array(plaintext)));
}

function getCookiesSizeBytes(cookies) {
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify(cookies)).length;
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

async function getUserId() {
  const data = await chromePromise(
      chrome.storage.local.get.bind(chrome.storage.local),
      [USER_ID_KEY]
  );
  return data[USER_ID_KEY] || "";
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
  const userId = await getUserId();
  if (!userId) {
    throw new Error(USK_I18N.t("error_user_id_missing"));
  }
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
  const cookiesSizeBytes = getCookiesSizeBytes(cookies);
  if (cookiesSizeBytes > COOKIE_SIZE_LIMIT_BYTES) {
    throw new Error(
        USK_I18N.t("error_cookie_size_exceeded", {
          limit: Math.round(COOKIE_SIZE_LIMIT_BYTES / 1024),
        })
    );
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
  const useE2E = Boolean(apiPassword);
  const device = "";
  const headers = {"Content-Type": "application/json"};
  const payloadData = {cookies, local_storage: localStorageMap};
  let requestBody = {
    user_id: userId,
    device,
    domain: rootDomain,
  };
  if (useE2E) {
    const encryptedPayload = await encryptE2EPayload(payloadData, apiPassword);
    requestBody = {
      ...requestBody,
      payload: encryptedPayload.payload,
      salt: encryptedPayload.salt,
      nonce: encryptedPayload.nonce,
    };
  } else {
    requestBody = {...requestBody, ...payloadData};
  }
  debugLog("[USK] Backup payload", {
    apiBase,
    domain: rootDomain,
    cookies: cookies.length,
    localStorageOrigins: Object.keys(localStorageMap).length,
    e2e: useE2E,
  });
  const backupPath = useE2E ? `${E2E_PREFIX}/backup` : "/backup";
  const response = await fetch(`${apiBase}${backupPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
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
  const userId = await getUserId();
  if (!userId) {
    throw new Error(USK_I18N.t("error_user_id_missing"));
  }
  const apiBase = await getApiBase();
  const apiPassword = await getApiPassword();
  const useE2E = Boolean(apiPassword);
  const headers = {"X-USK-User": userId};
  const restorePath = useE2E ? `${E2E_PREFIX}/restore` : "/restore";
  const response = await fetch(
      `${apiBase}${restorePath}/${encodeURIComponent(rootDomain)}`,
      {headers}
  );
  if (!response.ok) {
    if (!useE2E && response.status === 401) {
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
  let cookies = [];
  let localStorageMap = {};
  if (useE2E) {
    if (!apiPassword) {
      throw new Error(USK_I18N.t("error_password_required"));
    }
    try {
      const decrypted = await decryptE2EPayload(
          data.payload,
          data.salt,
          data.nonce,
          apiPassword
      );
      cookies = Array.isArray(decrypted.cookies) ? decrypted.cookies : [];
      localStorageMap = decrypted.local_storage || {};
    } catch (error) {
      throw new Error(USK_I18N.t("error_invalid_password"));
    }
  } else {
    cookies = Array.isArray(data.cookies) ? data.cookies : [];
    localStorageMap = data.local_storage || {};
  }
  const storeId = await getCookieStoreIdForTab(tab.id);

  await Promise.all(
      cookies.map((cookie) =>
          chromePromise(chrome.cookies.set, buildCookieDetails(cookie, storeId))
      )
  );

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
  const userId = await getUserId();
  if (!userId) {
    throw new Error(USK_I18N.t("error_user_id_missing"));
  }
  const apiBase = await getApiBase();
  const apiPassword = await getApiPassword();
  const deletePath = apiPassword ? `${E2E_PREFIX}/backup` : "/backup";
  const response = await fetch(
      `${apiBase}${deletePath}/${encodeURIComponent(rootDomain)}`,
      {method: "DELETE", headers: {"X-USK-User": userId}}
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
  const userId = await getUserId();
  if (!userId) {
    throw new Error(USK_I18N.t("error_user_id_missing"));
  }
  const apiPassword = await getApiPassword();
  const statusPath = apiPassword ? `${E2E_PREFIX}/status` : "/status";
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
    const response = await fetch(
        `${apiBase}${statusPath}/${encodeURIComponent(rootDomain)}`,
        {headers: {"X-USK-User": userId}}
    );
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
