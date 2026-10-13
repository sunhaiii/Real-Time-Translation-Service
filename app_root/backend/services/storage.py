from __future__ import annotations

import io
import logging
import os
import time
import wave
from datetime import datetime, timezone
from typing import Optional

try:
    from google.cloud import storage
except Exception:  # pragma: no cover
    storage = None  # type: ignore

logger = logging.getLogger(__name__)


def _safe_path_part(value: Optional[str], default: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raw = default
    safe = (
        raw.replace("/", "_")
        .replace("\\", "_")
        .replace(":", "_")
        .replace("*", "_")
        .replace("?", "_")
        .replace("\"", "_")
        .replace("<", "_")
        .replace(">", "_")
        .replace("|", "_")
    )
    return safe or default


class GCSAudioStorage:
    """GCS 오디오 업로드 유틸리티 (PCM -> WAV 변환 후 업로드)."""

    def __init__(self) -> None:
        self.bucket_name = (os.getenv("GCS_AUDIO_BUCKET") or "").strip()
        self.prefix = (os.getenv("GCS_AUDIO_PREFIX") or "audio/prod").strip().strip("/")
        self.enabled = bool(self.bucket_name and storage is not None)
        self._client = storage.Client() if self.enabled else None

        if self.enabled:
            logger.info("[AudioStorage] GCS 업로드 활성화: bucket=%s prefix=%s", self.bucket_name, self.prefix)
        else:
            logger.warning("[AudioStorage] GCS 업로드 비활성화: GCS_AUDIO_BUCKET 또는 google-cloud-storage를 확인하세요.")

    def _build_object_path(
        self,
        *,
        customer_name: Optional[str],
        device_id: Optional[str],
        session_id: str,
        chat_id: int,
        sender: str,
        request_id: Optional[str],
    ) -> str:
        now = datetime.now(timezone.utc)
        safe_customer_name = _safe_path_part(customer_name, "unknown-customer")
        safe_device_id = _safe_path_part(device_id, "unknown-device")
        safe_request_id = _safe_path_part(request_id, "no-request-id")
        ts_ms = int(time.time() * 1000)
        return (
            f"{self.prefix}/{safe_customer_name}/{safe_device_id}/{session_id}/{chat_id}/"
            f"{now:%Y/%m/%d}/{sender}/{safe_request_id}_{ts_ms}.wav"
        )

    @staticmethod
    def pcm_to_wav_bytes(pcm_bytes: bytes, sample_rate_hz: int) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)  # 16-bit PCM
            wav_file.setframerate(int(sample_rate_hz or 16000))
            wav_file.writeframes(pcm_bytes)
        return output.getvalue()

    def upload_pcm_as_wav(
        self,
        *,
        customer_name: Optional[str],
        device_id: Optional[str],
        session_id: str,
        chat_id: int,
        sender: str,
        request_id: Optional[str],
        sample_rate_hz: int,
        pcm_bytes: bytes,
    ) -> Optional[str]:
        if not self.enabled or not self._client:
            return None
        if not pcm_bytes:
            return None

        wav_bytes = self.pcm_to_wav_bytes(pcm_bytes, sample_rate_hz)
        object_path = self._build_object_path(
            customer_name=customer_name,
            device_id=device_id,
            session_id=session_id,
            chat_id=chat_id,
            sender=sender,
            request_id=request_id,
        )

        bucket = self._client.bucket(self.bucket_name)
        blob = bucket.blob(object_path)
        blob.upload_from_file(io.BytesIO(wav_bytes), content_type="audio/wav")
        return f"gs://{self.bucket_name}/{object_path}"
