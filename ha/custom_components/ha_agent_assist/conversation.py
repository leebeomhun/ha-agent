"""Conversation entity forwarding HA Assist requests to ha-agent."""
from __future__ import annotations

import logging
import aiohttp
from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_TOKEN, CONF_URL

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([HaAgentConversationEntity(entry)])


class HaAgentConversationEntity(conversation.ConversationEntity):
    """Conversation agent backed by ha-agent."""

    _attr_has_entity_name = True
    _attr_name = "집 비서 (ha-agent)"
    _attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_conversation"

    @property
    def supported_languages(self) -> list[str] | str:
        return "*"

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        url = self._entry.data[CONF_URL].rstrip("/")
        token = self._entry.data[CONF_TOKEN]
        conv_id = chat_log.conversation_id or user_input.conversation_id
        payload = {
            "text": user_input.text,
            "conversation_id": conv_id,
            "language": user_input.language or "ko",
            "device_id": user_input.device_id,
            "user_id": user_input.context.user_id if user_input.context else None,
            "channel": "ha_assist",
        }

        speech = "집 비서 서버에 연결하지 못했어요."
        continue_conv = False
        session = async_get_clientsession(self.hass)

        try:
            async with session.post(
                f"{url}/api/assist/converse",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
                timeout=aiohttp.ClientTimeout(total=95),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    speech = data.get("response", {}).get("speech") or "처리했어요."
                    conv_id = data.get("conversation_id") or conv_id
                    continue_conv = bool(data.get("continue_conversation", False))
                else:
                    body_text = await resp.text()
                    err_msg = body_text[:120]
                    try:
                        err_json = await resp.json(content_type=None)
                        if isinstance(err_json, dict) and err_json.get("error"):
                            err_msg = str(err_json["error"])
                    except Exception:
                        pass
                    _LOGGER.warning("ha-agent conversation HTTP %s: %s", resp.status, body_text[:200])
                    speech = f"집 비서 오류({resp.status}): {err_msg}"
        except Exception as err:
            _LOGGER.warning("ha-agent conversation error: %s", err)
            speech = "집 비서 서버와 연결이 원활하지 않아요. 잠시 후 다시 말씀해 주세요."

        intent_response = intent.IntentResponse(language=user_input.language or "ko")
        intent_response.async_set_speech(speech)
        return conversation.ConversationResult(
            response=intent_response,
            conversation_id=conv_id,
            continue_conversation=continue_conv,
        )
