# packages/coral-backend/src/coral_backend/messages.py
# coalesce leading system messages and map history into chat-template dicts

from __future__ import annotations

from typing import Any
import json

from coral_backend.protocol import (
    ChatJsonObject,
    ModelRequestMessage,
    OllamaTool,
    OllamaToolCall,
)


def arguments_dict(arguments: ChatJsonObject | dict[str, Any] | None) -> dict[str, Any]:
    if arguments is None:
        return {}
    if isinstance(arguments, dict):
        return dict(arguments)
    dumped = arguments.model_dump(exclude_none=True)
    dumped.pop("model_config", None)
    return dumped


# join every role:system into one leading message; git context is a second system
def coalesce_system_messages(
    messages: list[ModelRequestMessage],
) -> list[ModelRequestMessage]:
    system = [message for message in messages if message.role == "system"]
    if not system:
        return list(messages)
    joined = "\n\n".join(message.content for message in system)
    rest = [message for message in messages if message.role != "system"]
    return [ModelRequestMessage(role="system", content=joined), *rest]


def think_requested(think: bool | str | None) -> bool:
    return think is not None and think is not False


def to_template_message(message: ModelRequestMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": message.role, "content": message.content}
    if message.thinking:
        out["thinking"] = message.thinking
    if message.role == "tool" and message.tool_name:
        out["name"] = message.tool_name
        out["tool_name"] = message.tool_name
    if message.tool_calls:
        out["tool_calls"] = [
            _template_tool_call(call, index) for index, call in enumerate(message.tool_calls)
        ]
    return out


def to_hf_tools(tools: list[OllamaTool]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for tool in tools:
        parameters = tool.function.parameters.model_dump(exclude_none=True)
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "parameters": parameters,
                },
            }
        )
    return converted


def _template_tool_call(call: OllamaToolCall, fallback_index: int) -> dict[str, Any]:
    args = arguments_dict(call.function.arguments)
    index = call.function.index if call.function.index is not None else fallback_index
    return {
        "id": f"call_{index}",
        "type": call.type or "function",
        "function": {
            "name": call.function.name,
            "arguments": json.dumps(args),
            "index": index,
        },
        "name": call.function.name,
        "arguments": args,
    }
