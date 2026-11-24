---
"@mokalabs/proxy": patch
"@mokalabs/sandbox": patch
"@mokalabs/core": patch
"create-moka": patch
---

Reasoning **Off** now turns thinking off instead of only not asking for it: the lowest reasoning effort for OpenAI models, thinking disabled for Claude, minimum thinking for Gemini, and for local servers (LM Studio, Ollama, vLLM, llama.cpp) `reasoning_effort: "none"`, `chat_template_kwargs.enable_thinking: false` and Qwen3's `/no_think`.
