/**
 * UI assets for the demo MCP server: an MCP App (HTML, JSON-RPC over
 * postMessage) and an A2UI payload. They double as copy-paste examples for
 * people building their own servers.
 */

export const DICE_APP_URI = "ui://moka-demo/dice";

export const DICE_APP_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  /* Standard MCP Apps theme variables (sent by the host in ui/initialize), with fallbacks. */
  :root { color-scheme: light dark;
    --bg: var(--color-background-primary, #fff); --fg: var(--color-text-primary, #1d1714);
    --muted: var(--color-text-secondary, #6f6259); --line: var(--color-border-primary, #e9e4df);
    --accent: var(--color-accent, #b8622c); --accent-fg: var(--color-accent-foreground, #fff); }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  .wrap { padding: 16px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  h2 { font-size: 15px; margin: 0; }
  .muted { color: var(--muted); font-size: 12px; }
  .dice { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
  .die { width: 52px; height: 52px; border-radius: 12px; border: 1px solid var(--line); display: grid; place-items: center;
         font: 600 20px ui-monospace, monospace; animation: pop .35s ease-out both; }
  .die.max { border-color: var(--accent); color: var(--accent); }
  @keyframes pop { from { transform: scale(.6) rotate(-20deg); opacity: 0 } to { transform: none; opacity: 1 } }
  .total { font-size: 28px; font-weight: 700; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  button { font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 9px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  button:disabled { opacity: .5; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head"><h2>🎲 Dice roller</h2><span class="muted" id="spec">waiting for host…</span></div>
  <div class="dice" id="dice"></div>
  <div><span class="muted">Total</span> <span class="total" id="total">–</span></div>
  <div class="row">
    <button class="primary" id="again">Roll again</button>
    <button id="share">Tell the assistant</button>
  </div>
</div>
<script>
  // Minimal MCP Apps client: JSON-RPC 2.0 over postMessage.
  let nextId = 1, sides = 6, count = 1, last = null;
  const pending = new Map();
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const $ = (id) => document.getElementById(id);

  function render(result) {
    const data = result && result.structuredContent;
    if (!data || !Array.isArray(data.rolls)) return;
    last = data;
    $("dice").innerHTML = data.rolls.map((r) => '<div class="die' + (r === sides ? ' max' : '') + '">' + r + '</div>').join("");
    $("total").textContent = data.total;
    resize();
  }
  function applyTheme(ctx) {
    if (ctx && ctx.theme) document.documentElement.style.colorScheme = ctx.theme;
    const vars = (ctx && ctx.styles && ctx.styles.variables) || {};
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  }
  function resize() { notify("ui/notifications/size-changed", { height: document.documentElement.scrollHeight }); }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-input") {
      sides = msg.params.arguments.sides || 6; count = msg.params.arguments.count || 1;
    } else if (msg.method === "ui/notifications/tool-result") {
      render(msg.params);
    } else if (msg.method === "ui/notifications/host-context-changed") {
      applyTheme(msg.params);
    }
  });

  $("again").onclick = async () => {
    $("again").disabled = true;
    try { render(await rpc("tools/call", { name: "roll_dice", arguments: { sides, count } })); }
    finally { $("again").disabled = false; }
  };
  $("share").onclick = () => last && rpc("ui/message", {
    role: "user",
    content: { type: "text", text: "I rolled " + count + "d" + sides + " again in the app and got " + last.rolls.join(", ") + " (total " + last.total + ")." },
  });

  rpc("ui/initialize", {
    protocolVersion: "2026-01-26",
    clientInfo: { name: "moka-dice", version: "1.0.0" },
    capabilities: {},
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then((res) => {
    $("spec").textContent = "MCP App · " + ((res.hostInfo && res.hostInfo.name) || "host");
    applyTheme(res.hostContext);
    notify("ui/notifications/initialized", {});
    new ResizeObserver(resize).observe(document.body);
  });
</script>
</body>
</html>`;

/** A2UI v0.9 messages for a small booking form, returned by the `book_table` tool. */
export function bookingFormA2ui(restaurant: string, partySize: number) {
  const surfaceId = "booking";
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: "https://a2ui.org/specification/v0_9/standard_catalog.json" } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId,
        components: [
          { id: "root", component: "Card", child: "col" },
          { id: "col", component: "Column", children: ["title", "subtitle", "when", "size", "notes", "divider", "actions"] },
          { id: "title", component: "Text", text: { path: "/restaurant" }, variant: "h3" },
          { id: "subtitle", component: "Text", text: "Pick a time and we'll hold the table.", variant: "caption" },
          { id: "when", component: "DateTimeInput", value: { path: "/when" }, enableDate: true, enableTime: true, label: "When" },
          { id: "size", component: "Slider", label: "Party size", value: { path: "/partySize" }, min: 1, max: 12 },
          { id: "notes", component: "TextField", label: "Notes for the restaurant", value: { path: "/notes" }, variant: "longText" },
          { id: "divider", component: "Divider" },
          { id: "actions", component: "Row", children: ["confirm", "cancel"], justify: "end" },
          { id: "confirm-label", component: "Text", text: "Confirm booking" },
          {
            id: "confirm",
            component: "Button",
            variant: "primary",
            child: "confirm-label",
            action: { event: { name: "confirm_booking", context: { restaurant: { path: "/restaurant" }, when: { path: "/when" }, partySize: { path: "/partySize" }, notes: { path: "/notes" } } } },
          },
          { id: "cancel-label", component: "Text", text: "Cancel" },
          { id: "cancel", component: "Button", variant: "borderless", child: "cancel-label", action: { event: { name: "cancel_booking", context: {} } } },
        ],
      },
    },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { restaurant, partySize, when: "", notes: "" } } },
  ];
}
