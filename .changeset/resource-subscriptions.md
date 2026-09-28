---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

**Resource subscriptions and templates.**

- **Watch resources:** subscribe to a resource (`resources/subscribe`) from the Tools view. Every `notifications/resources/updated` re-reads it live and shows up in the inspector as `resource.updated`. Subscriptions survive reconnects.
- **Resource templates:** `resources/templates/list` is shown in the Tools view, with a form that expands RFC 6570 URI templates and reads the result.
- Typing **@** in the chat composer now opens the resource picker, filtered as you type (the @ button still works too).
- List-changed notifications for tools, prompts and resources now refresh the lists without a reconnect.
- The demo server gains a live **brew status** resource (changes every 3 seconds, supports subscriptions) and a **coffee drinks** resource template.

**Generative UI fixes.**

- Gemini: the render tool's schema now declares every component prop. Gemini drops arguments that aren't in the schema, which produced UIs missing `children`, `text` and other props.
- Playground "Ask a model": pick any model, and invalid UI is sent back to the model for up to 3 tries, like in chat.
- Playground: a bar shows which catalogs the chosen workspace uses, and each one can be turned on or off with a click. When a component comes from a catalog that isn't enabled (`unknown component "Meter"`), the problem says so and offers **Enable it**.
- "Send to playground" on a catalog component now opens the playground with that component loaded.
