# LangGraph agent with generative UI

A small [LangGraph](https://github.com/langchain-ai/langgraph) graph served over [AG-UI](https://docs.ag-ui.com) with `ag-ui-langgraph`. Its tools answer with [A2UI](https://github.com/google/A2UI), so Moka shows a real menu form and an order card in the chat, and every graph step, tool call and state snapshot in the inspector.

A scripted model stands in for the LLM, so it runs without API keys. Swap `ScriptedModel()` for `ChatOpenAI(...)`, `ChatAnthropic(...)` or any LangChain chat model to use a real one.

```bash
pip install -r requirements.txt
python agent.py                    # AG-UI endpoint on http://127.0.0.1:8123/agent

# in another terminal, from this folder
npx @mokalabs/sandbox              # uses ./moka.json
```

Ask *"I need a coffee"*, pick a drink and press **Order**. The button press goes back to the graph as a `[ui action]` message.

How it works:

- `show_menu` and `place_order` return A2UI messages (`createSurface`, `updateComponents`, `updateDataModel`) as their tool result. Moka renders any tool result that is A2UI.
- The form's **Order** button has an `action.event` with `context` bound to the form's data (`/drink`, `/size`, `/oat`), so the agent gets the user's choices.
- Graph nodes show up as steps in the inspector (`barista → tools → barista`).
