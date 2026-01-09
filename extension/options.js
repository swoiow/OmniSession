const API_BASE_KEY = "apiBase";
const API_PASSWORD_KEY = "apiPassword";
const USER_EMAIL_KEY = "userEmail";
const USER_ID_KEY = "userId";
const DEFAULT_API_BASE = "http://localhost:8000";
const DEBUG_LOGS_KEY = "debugLogs";
const NAMESPACE_X500 = "6ba7b814-9dad-11d1-80b4-00c04fd430c8";

const apiBaseInput = document.getElementById("api-base");
const apiPasswordInput = document.getElementById("api-password");
const userEmailInput = document.getElementById("user-email");
const showPasswordInput = document.getElementById("show-password");
const languageSelect = document.getElementById("language");
const debugLogsInput = document.getElementById("debug-logs");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const testBtn = document.getElementById("test");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
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

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes) {
  const hex = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0")
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function uuidv5(name, namespace) {
  const encoder = new TextEncoder();
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = encoder.encode(name);
  const data = new Uint8Array(namespaceBytes.length + nameBytes.length);
  data.set(namespaceBytes);
  data.set(nameBytes, namespaceBytes.length);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hash = new Uint8Array(hashBuffer);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return bytesToUuid(hash.slice(0, 16));
}

async function loadSettings() {
  const data = await chromePromise(
      chrome.storage.local.get.bind(chrome.storage.local),
      [
        API_BASE_KEY,
        API_PASSWORD_KEY,
        USER_EMAIL_KEY,
        USER_ID_KEY,
        DEBUG_LOGS_KEY,
        USK_I18N.LANG_KEY,
      ]
  );
  apiBaseInput.value = data[API_BASE_KEY] || DEFAULT_API_BASE;
  apiPasswordInput.value = data[API_PASSWORD_KEY] || "";
  userEmailInput.value = data[USER_EMAIL_KEY] || "";
  debugLogsInput.checked = Boolean(data[DEBUG_LOGS_KEY]);
  languageSelect.value =
      data[USK_I18N.LANG_KEY] || USK_I18N.getDefaultLang();
}

async function saveSettings() {
  const value = apiBaseInput.value.trim() || DEFAULT_API_BASE;
  const password = apiPasswordInput.value;
  const email = userEmailInput.value.trim().toLowerCase();
  const userId = email ? await uuidv5(email, NAMESPACE_X500) : "";
  const debugLogs = debugLogsInput.checked;
  const lang = languageSelect.value;
  await USK_I18N.setStoredLang(lang);
  await chromePromise(
      chrome.storage.local.set.bind(chrome.storage.local),
      {
        [API_BASE_KEY]: value,
        [API_PASSWORD_KEY]: password,
        [USER_EMAIL_KEY]: email,
        [USER_ID_KEY]: userId,
        [DEBUG_LOGS_KEY]: debugLogs,
      }
  );
  setStatus(USK_I18N.t("status_saved"));
}

async function testConnection() {
  const value = apiBaseInput.value.trim() || DEFAULT_API_BASE;
  setStatus(USK_I18N.t("status_testing"));
  try {
    const response = await fetch(`${value}/`);
    if (!response.ok) {
      throw new Error(
          USK_I18N.t("error_backend_responded", {status: response.status})
      );
    }
    setStatus(USK_I18N.t("status_connection_ok"));
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

saveBtn.addEventListener("click", () => {
  saveSettings().catch((error) => setStatus(error.message || String(error), true));
});

testBtn.addEventListener("click", () => {
  testConnection().catch((error) => setStatus(error.message || String(error), true));
});

showPasswordInput.addEventListener("change", () => {
  apiPasswordInput.type = showPasswordInput.checked ? "text" : "password";
});

languageSelect.addEventListener("change", () => {
  const lang = languageSelect.value;
  USK_I18N.setStoredLang(lang)
      .then(() => USK_I18N.apply(lang))
      .catch((error) => setStatus(error.message || String(error), true));
});

USK_I18N.apply()
    .then(() => loadSettings())
    .catch((error) => setStatus(error.message || String(error), true));
