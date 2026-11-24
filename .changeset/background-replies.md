---
"@mokalabs/proxy": patch
"@mokalabs/sandbox": patch
"@mokalabs/core": patch
"create-moka": patch
---

Replies keep running when you switch chats. Before, opening another chat or starting a new one stopped the reply in progress and threw it away (and a chat was only saved once its reply ended). Now the reply carries on in the background with a spinner in the sidebar, shows live when you come back, and is saved when it ends; your message is saved as soon as you send it. Stop still stops it.
