const USK_I18N = (() => {
  const LANG_KEY = "lang";
  const STRINGS = {
    en: {
      popup_title: "OmniSession",
      popup_hint: "Backup or restore the current site's login state.",
      label_backend: "Backend",
      label_backup: "Backup",
      button_backup: "Backup",
      button_restore: "Restore",
      button_delete: "Delete",
      status_checking: "Checking...",
      status_connected: "Connected",
      status_disconnected: "Disconnected",
      status_unavailable: "Unavailable",
      status_error: "Error",
      status_found: "Found",
      status_not_found: "Not found",
      status_working: "Working...",
      status_backend_unreachable: "Backend not reachable. Update settings.",
      status_backup_done: "Backup done for {domain} ({cookies} cookies)",
      status_restore_done: "Restore done for {domain} ({cookies} cookies)",
      status_delete_done: "Deleted backup for {domain}",
      status_delete_missing: "No backup found for {domain}",
      error_no_active_tab: "No active tab available",
      error_unsupported_page: "Unsupported page for {action}",
      error_backup_failed: "Backup failed ({status})",
      error_restore_failed: "Restore failed ({status})",
      error_delete_failed: "Delete failed ({status})",
      error_status_failed: "Status check failed ({status})",
      error_backend_responded: "Backend responded {status}",
      action_storage: "storage",
      action_backup: "backup",
      action_restore: "restore",
      action_delete: "delete",
      action_status: "status check",
      options_title: "OmniSession Settings",
      options_hint: "Set the FastAPI base URL used by the extension.",
      label_api_base: "API Base URL",
      label_password: "Encryption Password",
      label_debug_logs: "Debug Logs",
      label_language: "Language",
      button_save: "Save",
      button_test: "Test Connection",
      status_saved: "Saved.",
      status_testing: "Testing...",
      status_connection_ok: "Connection ok.",
      placeholder_password: "Leave empty to store plaintext",
      password_hint: "Optional. If set, the backend encrypts backups with this password.",
      error_password_required: "Password required for restore",
      error_invalid_password: "Invalid password",
      language_english: "English",
      language_chinese: "中文",
    },
    zh: {
      popup_title: "OmniSession",
      popup_hint: "备份或恢复当前网站的登录状态。",
      label_backend: "后端",
      label_backup: "备份",
      button_backup: "备份",
      button_restore: "恢复",
      button_delete: "删除",
      status_checking: "检查中...",
      status_connected: "已连接",
      status_disconnected: "未连接",
      status_unavailable: "不可用",
      status_error: "错误",
      status_found: "已存在",
      status_not_found: "未找到",
      status_working: "处理中...",
      status_backend_unreachable: "后端不可用，请更新设置。",
      status_backup_done: "备份完成：{domain}（{cookies} 个 Cookie）",
      status_restore_done: "恢复完成：{domain}（{cookies} 个 Cookie）",
      status_delete_done: "已删除：{domain}",
      status_delete_missing: "未找到备份：{domain}",
      error_no_active_tab: "未找到当前标签页",
      error_unsupported_page: "当前页面不支持{action}",
      error_backup_failed: "备份失败（{status}）",
      error_restore_failed: "恢复失败（{status}）",
      error_delete_failed: "删除失败（{status}）",
      error_status_failed: "状态查询失败（{status}）",
      error_backend_responded: "后端响应 {status}",
      action_storage: "存储",
      action_backup: "备份",
      action_restore: "恢复",
      action_delete: "删除",
      action_status: "状态查询",
      options_title: "OmniSession 设置",
      options_hint: "设置扩展使用的 FastAPI 地址。",
      label_api_base: "API Base URL",
      label_password: "加密密码",
      label_debug_logs: "调试日志",
      label_language: "语言",
      button_save: "保存",
      button_test: "测试连接",
      status_saved: "已保存。",
      status_testing: "测试中...",
      status_connection_ok: "连接正常。",
      placeholder_password: "留空则明文存储",
      password_hint: "可选。设置后后端会用此密码加密备份。",
      error_password_required: "恢复需要密码",
      error_invalid_password: "密码错误",
      language_english: "English",
      language_chinese: "中文",
    },
  };

  let currentLang = null;

  function normalizeLang(lang) {
    if (!lang) {
      return "en";
    }
    const lower = lang.toLowerCase();
    if (lower.startsWith("zh")) {
      return "zh";
    }
    return "en";
  }

  function getDefaultLang() {
    const uiLang = chrome?.i18n?.getUILanguage
        ? chrome.i18n.getUILanguage()
        : navigator.language;
    return normalizeLang(uiLang || "en");
  }

  function getMessages(lang) {
    const normalized = normalizeLang(lang);
    return STRINGS[normalized] || STRINGS.en;
  }

  function interpolate(text, params) {
    return text.replace(/\{(\w+)\}/g, (match, key) => {
      if (params && Object.prototype.hasOwnProperty.call(params, key)) {
        return String(params[key]);
      }
      return match;
    });
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  function storageSet(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async function resolveLang(forcedLang = null) {
    if (forcedLang) {
      return normalizeLang(forcedLang);
    }
    try {
      const data = await storageGet([LANG_KEY]);
      if (data[LANG_KEY]) {
        return normalizeLang(data[LANG_KEY]);
      }
    } catch (error) {
      return getDefaultLang();
    }
    return getDefaultLang();
  }

  async function init(forcedLang = null) {
    currentLang = await resolveLang(forcedLang);
    return currentLang;
  }

  async function apply(forcedLang = null) {
    currentLang = await resolveLang(forcedLang);
    const messages = getMessages(currentLang);

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      if (messages[key]) {
        el.textContent = messages[key];
      }
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.dataset.i18nPlaceholder;
      if (messages[key]) {
        el.setAttribute("placeholder", messages[key]);
      }
    });

    return currentLang;
  }

  function t(key, params = null, langOverride = null) {
    const lang = langOverride || currentLang || getDefaultLang();
    const messages = getMessages(lang);
    const text = messages[key] || key;
    return params ? interpolate(text, params) : text;
  }

  async function setStoredLang(lang) {
    const normalized = normalizeLang(lang);
    currentLang = normalized;
    await storageSet({[LANG_KEY]: normalized});
  }

  return {
    apply,
    init,
    t,
    setStoredLang,
    getDefaultLang,
    normalizeLang,
    LANG_KEY,
  };
})();
