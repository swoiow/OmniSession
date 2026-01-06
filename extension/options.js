const API_BASE_KEY = "apiBase";
const DEFAULT_API_BASE = "http://localhost:8000";
const DEBUG_LOGS_KEY = "debugLogs";

const apiBaseInput = document.getElementById("api-base");
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

async function loadSettings() {
  const data = await chromePromise(
      chrome.storage.local.get.bind(chrome.storage.local),
      [API_BASE_KEY, DEBUG_LOGS_KEY, USK_I18N.LANG_KEY]
  );
  apiBaseInput.value = data[API_BASE_KEY] || DEFAULT_API_BASE;
  debugLogsInput.checked = Boolean(data[DEBUG_LOGS_KEY]);
  languageSelect.value =
      data[USK_I18N.LANG_KEY] || USK_I18N.getDefaultLang();
}

async function saveSettings() {
  const value = apiBaseInput.value.trim() || DEFAULT_API_BASE;
  const debugLogs = debugLogsInput.checked;
  const lang = languageSelect.value;
  await USK_I18N.setStoredLang(lang);
  await chromePromise(
      chrome.storage.local.set.bind(chrome.storage.local),
      {[API_BASE_KEY]: value, [DEBUG_LOGS_KEY]: debugLogs}
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

languageSelect.addEventListener("change", () => {
  const lang = languageSelect.value;
  USK_I18N.setStoredLang(lang)
      .then(() => USK_I18N.apply(lang))
      .catch((error) => setStatus(error.message || String(error), true));
});

USK_I18N.apply()
    .then(() => loadSettings())
    .catch((error) => setStatus(error.message || String(error), true));
