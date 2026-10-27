/**
 * The inspector in its own window (`?popout=inspector`), e.g. on a second
 * screen. Same origin, so it signs in with the stored token and streams the
 * same events. The main window tells it which event to show.
 */
const CHANNEL = "moka-inspector";

export const isInspectorPopout = new URLSearchParams(window.location.search).get("popout") === "inspector";

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : undefined;
let popup: Window | null = null;

export function openInspectorWindow(): boolean {
  popup = window.open(`${window.location.pathname}?popout=inspector`, "moka-inspector", "popup,width=560,height=900");
  return Boolean(popup);
}

export function inspectorWindowOpen(): boolean {
  return Boolean(popup && !popup.closed);
}

/** Show an event in the inspector window (and bring it to the front). */
export function showInInspectorWindow(eventId: string | undefined): void {
  channel?.postMessage({ select: eventId });
  popup?.focus();
}

/** In the inspector window: follow the main window's selection. */
export function onInspectorSelect(handler: (eventId: string | undefined) => void): () => void {
  if (!channel) return () => {};
  const listener = (e: MessageEvent) => handler(e.data?.select);
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}
