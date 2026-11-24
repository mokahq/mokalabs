---
"@mokalabs/proxy": patch
"@mokalabs/sandbox": patch
"@mokalabs/core": patch
"create-moka": patch
---

When a prompt doesn't fit in the model's context window, the error now says how big it was (tool definitions by server, system prompt and skills, the conversation), the context LM Studio loaded the model with, and how to fix it for LM Studio, Ollama or a hosted model, with a button to the context budget where tools can be hidden.
