// Modified by ZCode Feiyu.
import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";

export async function checkRemotePlatformFallback(
  win: BrowserWindow,
  waitHost: (predicate: string) => Promise<unknown>,
): Promise<void> {
  await win.webContents.executeJavaScript("window.showReply('complete')");
  await waitHost(
    `document.querySelector('[data-testid="gen-ui-card"] [role="status"]')?.textContent.includes('Open this interactive view in the desktop app')`,
  );
  const remote = await win.webContents.executeJavaScript("window.inspectReact()");
  assert.equal(remote.reads, 0, "Remote reference must not read from the local Host");
  assert.equal(remote.remoteReads, 0, "Native Gen UI is not available on the remote Host");
  assert.equal(remote.preparations, 0, "Remote reference must not register a native page");
  assert.equal(remote.ports, 0);
  assert.equal(remote.states, 0);
  assert.equal(
    await win.webContents.executeJavaScript(
      "document.querySelectorAll('[data-testid=gen-ui-anchor], webview').length",
    ),
    0,
  );
  await win.webContents.executeJavaScript("window.setWorkspaceMode('local')");
}
