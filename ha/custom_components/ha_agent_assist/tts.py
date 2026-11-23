"""Text-to-Speech entity forwarding HA Assist TTS requests to ha-agent."""
from __future__ import annotations

import logging
from typing import Any

import aiohttp
from homeassistant.components import tts
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_TOKEN, CONF_URL

_LOGGER = logging.getLogger(__name__)

GEMINI_VOICES = [
    tts.Voice("Kore", "Kore (차분한 여성)"),
    tts.Voice("Zephyr", "Zephyr (밝은 여성)"),
    tts.Voice("Aoede", "Aoede (부드러운 여성)"),
    tts.Voice("Leda", "Leda (또렷한 여성)"),
    tts.Voice("Puck", "Puck (활기찬 남성)"),
    tts.Voice("Charon", "Charon (중후한 남성)"),
    tts.Voice("Fenrir", "Fenrir (경쾌한 남성)"),
    tts.Voice("Orus", "Orus (안정적인 남성)"),
]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([HaAgentTtsEntity(entry)])


class HaAgentTtsEntity(tts.TextToSpeechEntity):
    """Text-to-Speech entity backed by ha-agent (Gemini TTS)."""

    _attr_has_entity_name = True
    _attr_name = "집 비서 TTS"
    _attr_supported_languages = ["ko", "ko-KR", "en", "en-US"]
    _attr_default_language = "ko"
    _attr_supported_options = [tts.ATTR_VOICE]
    _attr_default_options = {tts.ATTR_VOICE: "Kore"}

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_tts"

    @callback
    def async_get_supported_voices(self, language: str) -> list[tts.Voice] | None:
        if language in self._attr_supported_languages or language.split("-")[0] in ("ko", "en"):
            return GEMINI_VOICES
        return None

    async def async_get_tts_audio(
        self, message: str, language: str, options: dict[str, Any]
    ) -> tts.TtsAudioType:
        url = self._entry.data[CONF_URL].rstrip("/")
        token = self._entry.data[CONF_TOKEN]
        voice = (options or {}).get(tts.ATTR_VOICE) or "Kore"
        session = async_get_clientsession(self.hass)

        try:
            async with session.post(
                f"{url}/api/assist/tts",
                json={"text": message, "language": language or "ko", "voice": voice},
                headers={"Authorization": f"Bearer {token}"},
                timeout=aiohttp.ClientTimeout(total=35),
            ) as resp:
                if resp.status != 200:
                    err = await resp.text()
                    _LOGGER.warning("ha-agent TTS HTTP %s: %s", resp.status, err[:200])
                    return None, None
                audio_bytes = await resp.read()
                if not audio_bytes:
                    return None, None
                return "wav", audio_bytes
        except Exception as err:
            _LOGGER.warning("ha-agent TTS error: %s", err)
            return None, None
