"""Google Cloud Text-to-Speech 서비스"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from typing import Optional

try:
    from google.cloud import texttospeech
except Exception:  # pragma: no cover
    texttospeech = None  # type: ignore

logger = logging.getLogger(__name__)


class TTSService:
    """Google Cloud Text-to-Speech 기반 TTS 서비스"""

    def __init__(self) -> None:
        if texttospeech is None:
            raise RuntimeError(
                "google-cloud-texttospeech가 설치되지 않았습니다. Google Cloud TTS를 사용하려면 설치하세요."
            )
        self._semaphore = asyncio.Semaphore(
            max(1, int((os.getenv("QSTT_TTS_CONCURRENCY") or "3").strip() or "3"))
        )
        self.client = texttospeech.TextToSpeechClient()
        self.default_voice_name = os.getenv("GCP_TTS_VOICE_NAME", "")
        self.default_gender = os.getenv("GCP_TTS_GENDER", "NEUTRAL").upper()

    def _voice(self, language_code: str) -> "texttospeech.VoiceSelectionParams":
        gender_map = {
            "MALE": texttospeech.SsmlVoiceGender.MALE,
            "FEMALE": texttospeech.SsmlVoiceGender.FEMALE,
            "NEUTRAL": texttospeech.SsmlVoiceGender.NEUTRAL,
        }
        kwargs = {
            "language_code": language_code or "en-US",
            "ssml_gender": gender_map.get(self.default_gender, texttospeech.SsmlVoiceGender.NEUTRAL),
        }
        if self.default_voice_name:
            kwargs["name"] = self.default_voice_name
        return texttospeech.VoiceSelectionParams(**kwargs)

    async def synthesize(
        self,
        text: str,
        language_code: str = "en-US",
        speaking_rate: float = 1.0,
        pitch: float = 0.0,
    ) -> Optional[str]:
        """base64로 인코딩된 MP3 오디오 반환"""
        if not text or not text.strip():
            return None

        synthesis_input = texttospeech.SynthesisInput(text=text.strip())
        voice = self._voice(language_code)
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=speaking_rate,
            pitch=pitch,
        )

        async with self._semaphore:
            response = await asyncio.to_thread(
                self.client.synthesize_speech,
                input=synthesis_input,
                voice=voice,
                audio_config=audio_config,
            )
        if not response.audio_content:
            return None

        logger.info("GCP TTS 생성 완료: %s자, 언어=%s", len(text), language_code)
        return base64.b64encode(response.audio_content).decode("utf-8")

