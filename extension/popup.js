const statusEl = document.getElementById("status");
const backendStatusEl = document.getElementById("backend-status");
const backupStatusEl = document.getElementById("backup-status");
const backupBtn = document.getElementById("backup");
const restoreBtn = document.getElementById("restore");
const deleteBtn = document.getElementById("delete");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setBusy(isBusy) {
  if (!isBusy) {
    return;
  }
  backupBtn.disabled = true;
  restoreBtn.disabled = true;
  deleteBtn.disabled = true;
}

function setControlsEnabled(backendOk, hasBackup) {
  backupBtn.disabled = !backendOk;
  restoreBtn.disabled = !backendOk;
  deleteBtn.disabled = !backendOk || !hasBackup;
}

function sendMessage(type) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({type}, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
        return;
      }
      if (!response || !response.ok) {
        reject(new Error(response?.error || "Request failed"));
        return;
      }
      resolve(response.result);
    });
  });
}

async function handleAction(type) {
  setBusy(true);
  setStatus(USK_I18N.t("status_working"));
  try {
    const result = await sendMessage(type);
    if (type === "backup") {
      setStatus(
          USK_I18N.t("status_backup_done", {
            domain: result.domain,
            cookies: result.cookies,
          })
      );
    } else if (type === "restore") {
      setStatus(
          USK_I18N.t("status_restore_done", {
            domain: result.domain,
            cookies: result.cookies,
          })
      );
    } else {
      setStatus(
          result.deleted
              ? USK_I18N.t("status_delete_done", {domain: result.domain})
              : USK_I18N.t("status_delete_missing", {domain: result.domain})
      );
    }
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
    await runCheck();
  }
}

async function runCheck() {
  try {
    const result = await sendMessage("check");
    if (!result.backendOk) {
      backendStatusEl.textContent = USK_I18N.t("status_disconnected");
      backupStatusEl.textContent = USK_I18N.t("status_unavailable");
      setStatus(USK_I18N.t("status_backend_unreachable"), true);
      setControlsEnabled(false, false);
      return;
    }

    backendStatusEl.textContent = USK_I18N.t("status_connected");
    if (result.hasBackup) {
      const updatedAt = result.updatedAt ? ` (${result.updatedAt})` : "";
      backupStatusEl.textContent = `${USK_I18N.t("status_found")}${updatedAt}`;
    } else {
      backupStatusEl.textContent = USK_I18N.t("status_not_found");
    }
    setStatus("");
    setControlsEnabled(true, result.hasBackup);
  } catch (error) {
    backendStatusEl.textContent = USK_I18N.t("status_error");
    backupStatusEl.textContent = USK_I18N.t("status_unavailable");
    setStatus(error.message || String(error), true);
    setControlsEnabled(false, false);
  }
}

backupBtn.addEventListener("click", () => handleAction("backup"));
restoreBtn.addEventListener("click", () => handleAction("restore"));
deleteBtn.addEventListener("click", () => handleAction("delete"));

USK_I18N.apply()
    .then((lang) => {
      uiLang = lang;
      return runCheck();
    })
    .catch(() => runCheck());
