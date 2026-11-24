---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

The chat input fits the model. Models that can think get a **Thinking** button with the choices they understand: Auto, Off, Low, Medium, High for OpenAI reasoning models, Claude, Gemini and gpt-oss; On or Off for hybrid models like Qwen3; models that always think say so. Speech-to-text models (Whisper, Parakeet…, or `"kind": "transcription"`) turn the chat into a transcriber: it takes audio files only (WAV, MP3, M4A, OGG, FLAC, WebM), adds a **Record** button for the microphone, and replies with the text through the server's `/audio/transcriptions` endpoint (OpenAI, Groq, oMLX, LocalAI, Speaches, whisper.cpp). Settings → Models has a new **Type** field.
