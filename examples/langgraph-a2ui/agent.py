"""A small LangGraph agent served over AG-UI (ag-ui-langgraph). Its tools answer
with A2UI, so the chat shows a real menu and an order card. A scripted model
stands in for the LLM so the demo runs without API keys."""
import asyncio, json, uuid
from typing import Annotated, AsyncIterator
from fastapi import FastAPI
import uvicorn
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.memory import MemorySaver
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint

CATALOG = "https://a2ui.org/specification/v0_9/standard_catalog.json"

def surface(sid, components, data=None):
    out = [{"version": "v0.9", "createSurface": {"surfaceId": sid, "catalogId": CATALOG}},
           {"version": "v0.9", "updateComponents": {"surfaceId": sid, "components": components}}]
    if data is not None:
        out.append({"version": "v0.9", "updateDataModel": {"surfaceId": sid, "path": "/", "value": data}})
    return out

class State(TypedDict, total=False):
    messages: Annotated[list, add_messages]

@tool
def check_stock(item: str) -> str:
    """Check whether an ingredient is in stock."""
    return json.dumps({"item": item, "in_stock": True, "left": 7})

@tool
def show_menu() -> str:
    """Show the user the drinks menu as a form (A2UI)."""
    return json.dumps(surface("menu", [
        {"id": "root", "component": "Card", "child": "col"},
        {"id": "col", "component": "Column", "children": ["title", "sub", "drink", "size", "oat", "actions"]},
        {"id": "title", "component": "Text", "text": "What can I brew you?", "variant": "h3"},
        {"id": "sub", "component": "Text", "text": "Oat milk is in stock (7 left).", "variant": "caption"},
        {"id": "drink", "component": "ChoicePicker", "label": "Drink", "variant": "mutuallyExclusive", "value": {"path": "/drink"},
         "options": [{"label": "Flat white", "value": "flat white"}, {"label": "Cappuccino", "value": "cappuccino"}, {"label": "Cold brew", "value": "cold brew"}]},
        {"id": "size", "component": "ChoicePicker", "label": "Size", "variant": "mutuallyExclusive", "value": {"path": "/size"},
         "options": [{"label": "Small", "value": "small"}, {"label": "Medium", "value": "medium"}, {"label": "Large", "value": "large"}]},
        {"id": "oat", "component": "CheckBox", "label": "Oat milk", "value": {"path": "/oat"}},
        {"id": "actions", "component": "Row", "children": ["order"], "justify": "end"},
        {"id": "order-label", "component": "Text", "text": "Order"},
        {"id": "order", "component": "Button", "variant": "primary", "child": "order-label",
         "action": {"event": {"name": "order_coffee", "context": {"drink": {"path": "/drink"}, "size": {"path": "/size"}, "oat": {"path": "/oat"}}}}},
    ], {"drink": ["flat white"], "size": ["medium"], "oat": True}))

@tool
def place_order(drink: str, size: str, oat: bool) -> str:
    """Place a coffee order and show its status card (A2UI)."""
    what = f"{size.capitalize()} {drink}" + (" · oat milk" if oat else "")
    return json.dumps(surface("order", [
        {"id": "root", "component": "Card", "child": "col"},
        {"id": "col", "component": "Column", "children": ["head", "what", "eta"]},
        {"id": "head", "component": "Row", "children": ["icon", "title"], "align": "center"},
        {"id": "icon", "component": "Icon", "name": "coffee"},
        {"id": "title", "component": "Text", "text": "Order #1042 is brewing", "variant": "h4"},
        {"id": "what", "component": "Text", "text": what},
        {"id": "eta", "component": "Text", "text": "Ready in about 4 minutes at the counter.", "variant": "caption"},
    ]))

def first(v, default):
    return (v[0] if v else default) if isinstance(v, list) else (v or default)

class ScriptedModel(BaseChatModel):
    """Stands in for a real LLM so the demo runs without API keys."""
    @property
    def _llm_type(self) -> str: return "scripted"
    def bind_tools(self, tools, **kw): return self

    def _plan(self, messages: list[BaseMessage]):
        last = messages[-1]
        human = next(m for m in reversed(messages) if isinstance(m, HumanMessage))
        text = human.content if isinstance(human.content, str) else json.dumps(human.content)
        if isinstance(last, HumanMessage):
            if "[ui action]" in text:
                ctx = json.loads(text.split("[ui action]", 1)[1]).get("context", {})
                return ("tool", "place_order", {"drink": first(ctx.get("drink"), "flat white"), "size": first(ctx.get("size"), "medium"), "oat": bool(ctx.get("oat"))})
            return ("tool", "check_stock", {"item": "oat milk"})
        if last.name == "check_stock":
            return ("tool", "show_menu", {})
        if last.name == "show_menu":
            return ("text", "Here's today's menu. Pick a drink and I'll start brewing. ☕", None)
        return ("text", "On it! Order **#1042** is brewing, ready in about 4 minutes.", None)

    def _generate(self, messages, stop=None, run_manager=None, **kw):
        kind, a, b = self._plan(messages)
        msg = AIMessage(content=a) if kind == "text" else AIMessage(content="", tool_calls=[{"name": a, "args": b, "id": "call_" + uuid.uuid4().hex[:8]}])
        return ChatResult(generations=[ChatGeneration(message=msg)])

    async def _astream(self, messages, stop=None, run_manager=None, **kw) -> AsyncIterator[ChatGenerationChunk]:
        kind, a, b = self._plan(messages)
        await asyncio.sleep(0.4)
        if kind == "text":
            for word in a.split(" "):
                chunk = ChatGenerationChunk(message=AIMessageChunk(content=word + " "))
                if run_manager: await run_manager.on_llm_new_token(chunk.text, chunk=chunk)
                yield chunk
                await asyncio.sleep(0.05)
        else:
            cid = "call_" + uuid.uuid4().hex[:8]
            args = json.dumps(b)
            pieces = [""] + [args[i:i + 8] for i in range(0, len(args), 8)]
            for i, p in enumerate(pieces):
                tc = {"name": a if i == 0 else None, "args": p, "id": cid if i == 0 else None, "index": 0}
                chunk = ChatGenerationChunk(message=AIMessageChunk(content="", tool_call_chunks=[tc]))
                if run_manager: await run_manager.on_llm_new_token("", chunk=chunk)
                yield chunk
                await asyncio.sleep(0.03)

model = ScriptedModel()

async def barista(state: State):
    return {"messages": [await model.ainvoke(state["messages"])]}

def route(state: State):
    return "tools" if state["messages"][-1].tool_calls else END

g = StateGraph(State)
g.add_node("barista", barista)
g.add_node("tools", ToolNode([check_stock, show_menu, place_order]))
g.add_edge(START, "barista")
g.add_conditional_edges("barista", route, ["tools", END])
g.add_edge("tools", "barista")
graph = g.compile(checkpointer=MemorySaver())

app = FastAPI()
add_langgraph_fastapi_endpoint(app, LangGraphAgent(name="barista", description="LangGraph coffee agent", graph=graph), "/agent")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8123, log_level="warning")
