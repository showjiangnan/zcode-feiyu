// Modified by ZCode Feiyu.
import type { WebContents } from "electron";
import { evaluateGuest } from "./guest-evaluation.js";

export async function observeGuestPointerInput(guest: WebContents): Promise<void> {
  await evaluateGuest(
    guest,
    `(() => {
    window.fixturePointerEvents = [];
    if (window.fixturePointerObserved) return;
    window.fixturePointerObserved = true;
    for (const type of ['pointerdown', 'pointerup', 'click', 'focusin', 'input']) {
      document.addEventListener(type, event => window.fixturePointerEvents.push({
        type, id: event.target.id, trusted: event.isTrusted,
        counter: document.querySelector('#counter').textContent,
        x: event.clientX, y: event.clientY,
      }), true);
    }
  })()`,
  );
}

export async function waitForGuestPointerState(
  guest: WebContents,
  predicate: string,
): Promise<void> {
  await evaluateGuest(
    guest,
    `new Promise((resolve, reject) => {
    const events = ['fixture-input-commit', 'click', 'focusin', 'input'];
    const cleanup = () => {
      clearTimeout(timeout);
      for (const type of events) window.removeEventListener(type, check);
    };
    const check = () => {
      if (${predicate}) { cleanup(); resolve(); }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Guest pointer state ACK timed out: ' + ${JSON.stringify(predicate)} + JSON.stringify({
        commit: window.fixtureInputCommit, focus: document.activeElement.id,
        counter: document.querySelector('#counter').textContent,
        events: window.fixturePointerEvents,
      })));
    }, 3000);
    for (const type of events) window.addEventListener(type, check);
    check();
  })`,
  );
}
