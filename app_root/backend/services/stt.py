"""
단일 호출 + 스트리밍을 지원하는 Google Cloud Speech-to-Text 서비스 (v1/v2)

[STT 성능 개선]
1) model=chirp_3 (v2)
   - Google Speech-to-Text v2 전용 최신 ASR 모델.
   - ko-KR GA 지원. latest_short/latest_long 대비 정확도·속도 향상.
   - Chirp 3 는 us / eu 멀티리전만 지원 (global 불가) → GCP_STT_LOCATION 환경변수로 지정.

2) Speech adaptation (PhraseSet 참조)
   - 도메인/전문 용어를 인식에 반영하려면 GCP v2 리전에 PhraseSet을 만든 뒤 resource name을 넘깁니다.
   - 적용 위치: _build_recognition_config()에서 RecognitionConfig.adaptation 설정.
   - phrase_set_references: PhraseSet 리소스 전체 경로 목록
     (예: projects/PROJECT/locations/us/phraseSets/ID).
   - PhraseSet 생성: scripts/phrase_sets.py 실행 또는 GCP 콘솔.
   - 환경 변수 GCP_STT_PHRASE_SET_REFERENCES="리소스경로1,리소스경로2" 로 기본 지정 가능.

3) STT 후처리: 도메인 사전 + Fuzzy matching
   - STT 결과에서 도메인 용어와 유사한 오인식을 자동 보정합니다.
   - set_domain_terms()로 도메인 용어 목록을 동적으로 교체할 수 있습니다.
   - 인접 토큰 묶기: "정기 예금" → "정기예금" 처럼 공백으로 분리된 경우도 처리합니다.
   - 적용 위치: _apply_corrections() → transcribe() 및 스트리밍 결과 반환 직전에 호출됩니다.
   - 임계값(_FUZZY_THRESHOLD)이나 용어 추가는 set_domain_terms()를 통해 런타임에 갱신 가능합니다.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import queue
import threading
import time
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, List, Optional

try:
    from google.cloud.speech_v2 import SpeechClient
    from google.cloud.speech_v2.types import cloud_speech
    from google.api_core.client_options import ClientOptions
except Exception:  # pragma: no cover
    SpeechClient = None  # type: ignore
    cloud_speech = None  # type: ignore
    ClientOptions = None  # type: ignore

try:
    from google.cloud import speech_v1 as speech_v1
except Exception:  # pragma: no cover
    speech_v1 = None  # type: ignore

logger = logging.getLogger(__name__)

_FUZZY_THRESHOLD = 0.75
_FUZZY_MIN_TERM_LEN = 3


def _load_project_id_from_credentials() -> Optional[str]:
    """GOOGLE_APPLICATION_CREDENTIALS 또는 기본 경로에서 project_id를 읽어 반환."""
    creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_path:
        # main.py 기준 상대경로 fallback
        candidate = Path(__file__).resolve().parent.parent / "credentials.json"
        if candidate.exists():
            creds_path = str(candidate)
    if creds_path:
        try:
            with open(creds_path, encoding="utf-8") as f:
                data = json.load(f)
            return data.get("project_id")
        except Exception:
            pass
    return None


@dataclass
class StreamingResult:
    text: str
    is_final: bool
    error: Optional[str] = None


@dataclass
class _StreamingSession:
    key: str
    language_code: str
    sample_rate_hz: int
    mime_type: str
    started_at: float = field(default_factory=time.monotonic)
    phrase_set_references: Optional[List[str]] = None
    request_q: "queue.Queue[Optional[bytes]]" = field(default_factory=queue.Queue)
    result_q: "queue.Queue[StreamingResult]" = field(default_factory=queue.Queue)
    final_parts: list[str] = field(default_factory=list)
    initial_chunks: list[bytes] = field(default_factory=list)
    recent_chunks: list[bytes] = field(default_factory=list)
    closed: bool = False
    thread: Optional[threading.Thread] = None


class STTService:
    """Google Cloud Speech-to-Text 서비스 (STT_ENGINE=v1|v2)"""

    def __init__(self) -> None:
        self.engine = (os.getenv("STT_ENGINE", "v2") or "v2").strip().lower()
        if self.engine not in {"v1", "v2"}:
            logger.warning("[STT] 알 수 없는 STT_ENGINE=%s → v2로 폴백", self.engine)
            self.engine = "v2"

        self.default_language = os.getenv("GCP_STT_DEFAULT_LANG", "ko-KR")

        if self.engine == "v2":
            if SpeechClient is None or cloud_speech is None or ClientOptions is None:
                raise RuntimeError(
                    "google-cloud-speech(v2) is not installed. Install it to enable Google Cloud STT v2"
                )
            self._location = (
                os.getenv("GCP_STT_V2_LOCATION")
                or "us"
            ).strip()
            # 리전 엔드포인트 명시: 기본 SpeechClient() 는 global 엔드포인트를 사용해
            # us/eu recognizer 경로를 거부함 → 리전별 api_endpoint 를 직접 지정해야 함
            self.client = SpeechClient(
                client_options=ClientOptions(
                    api_endpoint=f"{self._location}-speech.googleapis.com"
                )
            )
        else:
            if speech_v1 is None:
                raise RuntimeError(
                    "google-cloud-speech(v1) is not installed. Install it to enable Google Cloud STT v1"
                )
            self._location = (
                os.getenv("GCP_STT_LOCATION")
                or "global"
            ).strip()
            self.client = speech_v1.SpeechClient()

        project_id = os.getenv("GCP_PROJECT_ID") or _load_project_id_from_credentials()
        if not project_id:
            raise RuntimeError(
                "GCP project_id 를 찾을 수 없습니다. "
                "GCP_PROJECT_ID 환경변수를 설정하거나 credentials.json 에 project_id 필드를 확인하세요."
            )
        self._project_id = project_id
        self._recognizer = (
            f"projects/{self._project_id}/locations/{self._location}/recognizers/_"
            if self.engine == "v2"
            else ""
        )

        self._stream_lock = threading.Lock()
        self._streams: dict[str, _StreamingSession] = {}

        # Speech adaptation: v2에서는 PhraseSet 참조를 사용 가능.
        # v1에서는 해당 참조값을 수신해도 API 스펙상 직접 사용하지 않음.
        refs_env_key = (
            "GCP_STT_V2_PHRASE_SET_REFERENCES"
            if self.engine == "v2"
            else "GCP_STT_PHRASE_SET_REFERENCES"
        )
        _refs_env = (os.getenv(refs_env_key) or "").strip().strip('"').strip("'")
        self._default_phrase_set_references: List[str] = [
            s.strip() for s in _refs_env.split(",") if s.strip()
        ]
        if self._default_phrase_set_references:
            if self.engine == "v2":
                logger.info("[STT] Speech adaptation PhraseSet 로드됨: %s", self._default_phrase_set_references)
            else:
                logger.warning(
                    "[STT] STT_ENGINE=v1 에서는 PhraseSet 참조를 사용하지 않습니다: %s",
                    self._default_phrase_set_references,
                )
        else:
            logger.warning("[STT] %s 가 비어 있음", refs_env_key)


        # 도메인 용어 사전 (인스턴스 레벨, set_domain_terms()로 교체)
        self._terms_by_len: dict[int, list[str]] = {}
        self._terms_lock = threading.Lock()

    def _request_metadata(self) -> list[tuple[str, str]]:
        """리전 recognizer 라우팅을 위한 gRPC 메타데이터."""
        return [("x-goog-request-params", f"recognizer={self._recognizer}")]

    def set_domain_terms(self, terms: list[str]) -> None:
        """도메인 용어 목록을 갱신한다. 스트리밍 중 호출해도 안전."""
        by_len: dict[int, list[str]] = {}
        for t in terms:
            if t:
                by_len.setdefault(len(t), []).append(t)
        with self._terms_lock:
            self._terms_by_len = by_len
        logger.info("[STT] 도메인 용어 %d개 로드됨", len(terms))

    def _find_fuzzy_match(self, substring: str) -> Optional[str]:
        """substring과 가장 유사한 도메인 용어를 반환. 없으면 None."""
        sub_len = len(substring)
        best_match: Optional[str] = None
        best_ratio = _FUZZY_THRESHOLD
        with self._terms_lock:
            terms_by_len = self._terms_by_len
        for term_len in range(max(_FUZZY_MIN_TERM_LEN, sub_len - 1), sub_len + 2):
            for term in terms_by_len.get(term_len, []):
                ratio = SequenceMatcher(None, substring, term).ratio()
                if ratio >= best_ratio:
                    best_ratio = ratio
                    best_match = term
        return best_match

    def _apply_fuzzy_to_tokens(self, text: str) -> str:
        """공백 기준 토큰 단위로 fuzzy matching 적용 (단일 토큰 + 인접 토큰 묶음)."""
        with self._terms_lock:
            if not self._terms_by_len:
                return text
        tokens = text.split()
        changed = False
        result_tokens: list[str] = []
        i = 0
        while i < len(tokens):
            matched = False
            # 인접 2~3 토큰을 붙여서 시도 (예: "정기 예금" → "정기예금")
            for span in (3, 2):
                if i + span <= len(tokens):
                    joined = "".join(tokens[i:i + span])
                    if len(joined) >= _FUZZY_MIN_TERM_LEN:
                        match = self._find_fuzzy_match(joined)
                        if match and match != joined:
                            result_tokens.append(match)
                            changed = True
                            matched = True
                            i += span
                            break
            if matched:
                continue
            # 단일 토큰
            token = tokens[i]
            if len(token) >= _FUZZY_MIN_TERM_LEN:
                match = self._find_fuzzy_match(token)
                if match and match != token:
                    result_tokens.append(match)
                    changed = True
                else:
                    result_tokens.append(token)
            else:
                result_tokens.append(token)
            i += 1
        return " ".join(result_tokens) if changed else text

    def _apply_corrections(self, text: str) -> str:
        """STT 결과 후처리: fuzzy 보정."""
        if not text:
            return text
        original = text
        text = self._apply_fuzzy_to_tokens(text)
        if text != original:
            logger.info("[STT 후처리] '%s' → '%s'", original, text)
        return text

    def _is_pcm(self, mime_type: str) -> bool:
        mime = (mime_type or "").lower()
        return "audio/pcm" in mime or "pcm" in mime or "wav" in mime or "wave" in mime

    def _decoding_config(self, mime_type: str, sample_rate_hz: Optional[int]):
        """v2 디코딩 설정 반환. PCM은 명시적 설정, 나머지는 자동 감지."""
        if cloud_speech is None:
            raise RuntimeError("cloud_speech(v2) is unavailable")
        if self._is_pcm(mime_type):
            return cloud_speech.ExplicitDecodingConfig(
                encoding=cloud_speech.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=sample_rate_hz or 16000,
                audio_channel_count=1,
            )
        return cloud_speech.AutoDetectDecodingConfig()

    def _stt_language_code(self, language_code: str) -> str:
        """앱 언어 코드를 GCP Speech 지원 로케일 코드로 정규화"""
        code = (language_code or self.default_language or "").strip()
        stt_map = {
            # Chirp 3 STT 전용 정규화:
            # - bare code → 대표 BCP-47 로케일
            # - 일부 앱 전용/번역 전용 코드는 Chirp 3 us 리전 지원 로케일로 폴백
            "af": "af-ZA",
            "sq": "sq-AL",
            "am": "am-ET",
            "ar": "ar-DZ",
            "hy": "hy-AM",
            "az": "az-AZ",
            "eu": "eu-ES",
            "be": "be-BY",
            "bn": "bn-BD",
            "bs": "bs-BA",
            "bg": "bg-BG",
            "my": "my-MM",
            "ca": "ca-ES",
            "cs": "cs-CZ",
            "cy": "cy-GB",
            "da": "da-DK",
            "de": "de-DE",
            "el": "el-GR",
            "en": "en-US",
            "en-SG": "en-US",
            "et": "et-EE",
            "fa": "fa-IR",
            "fi": "fi-FI",
            "fr": "fr-FR",
            "ga": "ga-IE",
            "gu": "gu-IN",
            "ha": "ha-NG",
            "he": "he-IL",
            "hi": "hi-IN",
            "hr": "hr-HR",
            "hu": "hu-HU",
            "id": "id-ID",
            "ig": "ig-NG",
            "is": "is-IS",
            "it": "it-IT",
            "ja": "ja-JP",
            "ka": "ka-GE",
            "kk": "kk-KZ",
            "km": "km-KH",
            "kn": "kn-IN",
            "ko": "ko-KR",
            "ky": "ky-KG",
            "lo": "lo-LA",
            "lt": "lt-LT",
            "lv": "lv-LV",
            "mk": "mk-MK",
            "ml": "ml-IN",
            "mn": "mn-MN",
            "mr": "mr-IN",
            "ms": "ms-MY",
            "nb": "nb-NO",
            "no": "nb-NO",
            "ne": "ne-NP",
            "nl": "nl-NL",
            "or": "or-IN",
            "pa": "pa-IN",
            "pl": "pl-PL",
            "pt": "pt-BR",
            "ro": "ro-RO",
            "ru": "ru-RU",
            "si": "si-LK",
            "sk": "sk-SK",
            "sl": "sl-SI",
            "so": "so-SO",
            "es": "es-ES",
            "sr": "sr-RS",
            "sv": "sv-SE",
            "sw": "sw-KE",
            "ta": "ta-IN",
            "te": "te-IN",
            "tg": "tg-TJ",
            "tl": "fil-PH",
            "tl-PH": "fil-PH",
            "fil": "fil-PH",
            "tr": "tr-TR",
            "uk": "uk-UA",
            "ur": "ur-PK",
            "uz": "uz-UZ",
            "vi": "vi-VN",
            "zu": "zu-ZA",
            "zh": "cmn-Hans-CN",
            "zh-Hans": "cmn-Hans-CN",
            "zh-Hant": "cmn-Hant-TW",
            "zh-CN": "cmn-Hans-CN",
            "zh-TW": "cmn-Hant-TW",
            "zh-HK": "yue-Hant-HK",
            "yue-HK": "yue-Hant-HK",
            "yue": "yue-Hant-HK",
        }
        return stt_map.get(code, code or self.default_language)

    def _build_recognition_config(
        self,
        language_code: str,
        mime_type: str,
        sample_rate_hz: Optional[int] = None,
        phrase_set_references: Optional[List[str]] = None,
    ) -> "cloud_speech.RecognitionConfig":
        """
        v2 RecognitionConfig 생성.
        - model: chirp_3 고정
        - phrase_set_references: GCP PhraseSet 리소스 경로 목록 → adaptation으로 도메인 용어 반영
        """
        normalized_lang = self._stt_language_code(language_code)

        config_kw: dict = {
            "model": "chirp_3",
            "language_codes": [normalized_lang],
            "features": cloud_speech.RecognitionFeatures(
                enable_automatic_punctuation=True,
                max_alternatives=3,
            ),
        }

        decoding = self._decoding_config(mime_type, sample_rate_hz)
        if isinstance(decoding, cloud_speech.ExplicitDecodingConfig):
            config_kw["explicit_decoding_config"] = decoding
        else:
            config_kw["auto_decoding_config"] = decoding

        if phrase_set_references:
            config_kw["adaptation"] = cloud_speech.SpeechAdaptation(
                phrase_sets=[
                    cloud_speech.SpeechAdaptation.AdaptationPhraseSet(
                        phrase_set=ref
                    )
                    for ref in phrase_set_references
                ]
            )
            logger.debug("[STT] adaptation 적용: %s", phrase_set_references)
        else:
            logger.debug("[STT] adaptation 미적용 (phrase_set_references 없음)")

        return cloud_speech.RecognitionConfig(**config_kw)

    def _v1_audio_encoding(self, mime_type: str):
        if speech_v1 is None:
            raise RuntimeError("speech_v1 is unavailable")
        mime = (mime_type or "").lower()
        if "webm" in mime and "opus" in mime:
            return speech_v1.RecognitionConfig.AudioEncoding.WEBM_OPUS
        if "ogg" in mime and "opus" in mime:
            return speech_v1.RecognitionConfig.AudioEncoding.OGG_OPUS
        if self._is_pcm(mime_type):
            return speech_v1.RecognitionConfig.AudioEncoding.LINEAR16
        return speech_v1.RecognitionConfig.AudioEncoding.ENCODING_UNSPECIFIED

    def _build_recognition_config_v1(
        self,
        language_code: str,
        mime_type: str,
        sample_rate_hz: Optional[int] = None,
    ):
        if speech_v1 is None:
            raise RuntimeError("speech_v1 is unavailable")
        normalized_lang = self._stt_language_code(language_code)
        model = (os.getenv("GCP_STT_V1_MODEL") or "latest_long").strip()
        cfg: dict[str, Any] = {
            "language_code": normalized_lang,
            "enable_automatic_punctuation": True,
            "max_alternatives": 3,
            "model": model,
        }
        use_enhanced_env = (os.getenv("GCP_STT_V1_USE_ENHANCED", "0") or "0").strip().lower()
        if use_enhanced_env in {"1", "true", "yes", "on"}:
            cfg["use_enhanced"] = True

        # v1 정확도 보강용 phrase hints (쉼표 구분)
        # 예) GCP_STT_V1_HINT_PHRASES="국민은행,신한은행,여권번호,외국인등록번호"
        hint_phrases_raw = (os.getenv("GCP_STT_V1_HINT_PHRASES") or "").strip()
        if hint_phrases_raw:
            hint_phrases = [p.strip() for p in hint_phrases_raw.split(",") if p.strip()]
            if hint_phrases:
                try:
                    hint_boost = float((os.getenv("GCP_STT_V1_HINT_BOOST") or "15").strip())
                except Exception:
                    hint_boost = 15.0
                cfg["speech_contexts"] = [
                    speech_v1.SpeechContext(phrases=hint_phrases, boost=hint_boost)
                ]

        encoding = self._v1_audio_encoding(mime_type)
        if encoding != speech_v1.RecognitionConfig.AudioEncoding.ENCODING_UNSPECIFIED:
            cfg["encoding"] = encoding
        if sample_rate_hz:
            cfg["sample_rate_hertz"] = sample_rate_hz
        return speech_v1.RecognitionConfig(**cfg)

    async def transcribe(
        self,
        audio_data: str,
        language_code: str = "ko-KR",
        mime_type: str = "audio/webm;codecs=opus",
        sample_rate_hz: Optional[int] = None,
        phrase_set_references: Optional[List[str]] = None,
    ) -> Optional[str]:
        """base64로 인코딩된 오디오 바이트를 텍스트로 변환"""
        if not audio_data:
            return None

        audio_bytes = base64.b64decode(audio_data)
        if not audio_bytes:
            return None

        refs = (
            phrase_set_references
            if phrase_set_references is not None
            else self._default_phrase_set_references
        )
        if self.engine == "v2":
            config = self._build_recognition_config(
                language_code,
                mime_type,
                sample_rate_hz,
                phrase_set_references=refs if refs else None,
            )
            request = cloud_speech.RecognizeRequest(
                recognizer=self._recognizer,
                config=config,
                content=audio_bytes,
            )
            try:
                response = self.client.recognize(
                    request=request,
                    metadata=self._request_metadata(),
                )
            except Exception:
                logger.exception("[STT v2] recognize 요청 실패")
                raise
        else:
            if refs:
                logger.debug("[STT v1] phrase_set_references는 무시됩니다: %s", refs)
            config = self._build_recognition_config_v1(
                language_code=language_code,
                mime_type=mime_type,
                sample_rate_hz=sample_rate_hz,
            )
            audio = speech_v1.RecognitionAudio(content=audio_bytes)
            try:
                response = self.client.recognize(config=config, audio=audio)
            except Exception:
                logger.exception("[STT v1] recognize 요청 실패")
                raise

        parts: list[str] = []
        for result in response.results:
            if result.alternatives:
                text = (result.alternatives[0].transcript or "").strip()
                if text:
                    parts.append(text)
                for idx, alt in enumerate(result.alternatives):
                    conf = getattr(alt, "confidence", 0.0)
                    logger.info(
                        "[STT 후보 %d] (confidence=%.3f) %s",
                        idx, conf, (alt.transcript or "").strip(),
                    )

        transcript = self._apply_corrections(" ".join(parts).strip())
        logger.info("GCP STT(%s) 결과: %s", self.engine, transcript[:120])
        return transcript or None

    def _stream_worker(self, session: _StreamingSession) -> None:
        if self.engine == "v1":
            self._stream_worker_v1(session)
            return
        _monotonic = time.monotonic

        try:
            refs = (
                session.phrase_set_references
                if session.phrase_set_references is not None
                else self._default_phrase_set_references
            )
            config = self._build_recognition_config(
                session.language_code,
                session.mime_type,
                session.sample_rate_hz,
                phrase_set_references=refs if refs else None,
            )
            streaming_config = cloud_speech.StreamingRecognitionConfig(
                config=config,
                streaming_features=cloud_speech.StreamingRecognitionFeatures(
                    interim_results=True,
                ),
            )

            is_pcm = self._is_pcm(session.mime_type)
            silent_chunk = b"\x00\x00" * 1600 if is_pcm else b""

            def request_iter():
                # v2: 첫 번째 요청에 recognizer + streaming_config 포함
                yield cloud_speech.StreamingRecognizeRequest(
                    recognizer=self._recognizer,
                    streaming_config=streaming_config,
                )
                last_sent_at = _monotonic()
                for bridge_chunk in session.initial_chunks:
                    if not bridge_chunk:
                        continue
                    last_sent_at = _monotonic()
                    yield cloud_speech.StreamingRecognizeRequest(audio=bridge_chunk)
                while True:
                    try:
                        chunk = session.request_q.get(timeout=0.4)
                    except queue.Empty:
                        chunk = b""

                    if chunk is None:
                        break

                    if chunk:
                        last_sent_at = _monotonic()
                        yield cloud_speech.StreamingRecognizeRequest(audio=chunk)
                        continue

                    if silent_chunk and (_monotonic() - last_sent_at) >= 0.3:
                        last_sent_at = _monotonic()
                        yield cloud_speech.StreamingRecognizeRequest(audio=silent_chunk)

            responses = self.client.streaming_recognize(
                requests=request_iter(),
                metadata=self._request_metadata(),
            )
            try:
                for response in responses:
                    for result in response.results:
                        if not result.alternatives:
                            continue
                        text = self._apply_corrections(
                            (result.alternatives[0].transcript or "").strip()
                        )
                        if not text:
                            continue
                        is_final = bool(result.is_final)
                        if is_final:
                            for idx, alt in enumerate(result.alternatives):
                                conf = getattr(alt, "confidence", 0.0)
                                logger.info(
                                    "[STT 스트리밍 후보 %d] (confidence=%.3f) %s",
                                    idx, conf, (alt.transcript or "").strip(),
                                )
                            session.final_parts.append(text)
                        session.result_q.put(StreamingResult(text=text, is_final=is_final))
            except Exception as exc:
                logger.exception("GCP 스트리밍 STT 응답 처리 실패 [%s]", session.key)
                session.result_q.put(StreamingResult(text="", is_final=True, error=str(exc)))
        except Exception as exc:  # pragma: no cover
            logger.exception("GCP 스트리밍 STT 워커 실패 [%s]", session.key)
            session.result_q.put(StreamingResult(text="", is_final=True, error=str(exc)))
        finally:
            session.closed = True

    def _stream_worker_v1(self, session: _StreamingSession) -> None:
        if speech_v1 is None:
            session.result_q.put(StreamingResult(text="", is_final=True, error="speech_v1 unavailable"))
            session.closed = True
            return
        _monotonic = time.monotonic
        try:
            config = self._build_recognition_config_v1(
                language_code=session.language_code,
                mime_type=session.mime_type,
                sample_rate_hz=session.sample_rate_hz,
            )
            streaming_config = speech_v1.StreamingRecognitionConfig(
                config=config,
                interim_results=True,
                single_utterance=False,
            )

            is_pcm = self._is_pcm(session.mime_type)
            silent_chunk = b"\x00\x00" * 1600 if is_pcm else b""

            def request_iter():
                yield speech_v1.StreamingRecognizeRequest(
                    streaming_config=streaming_config
                )
                last_sent_at = _monotonic()
                for bridge_chunk in session.initial_chunks:
                    if not bridge_chunk:
                        continue
                    last_sent_at = _monotonic()
                    yield speech_v1.StreamingRecognizeRequest(audio_content=bridge_chunk)
                while True:
                    try:
                        chunk = session.request_q.get(timeout=0.4)
                    except queue.Empty:
                        chunk = b""

                    if chunk is None:
                        break

                    if chunk:
                        last_sent_at = _monotonic()
                        yield speech_v1.StreamingRecognizeRequest(audio_content=chunk)
                        continue

                    if silent_chunk and (_monotonic() - last_sent_at) >= 0.3:
                        last_sent_at = _monotonic()
                        yield speech_v1.StreamingRecognizeRequest(audio_content=silent_chunk)

            responses = self.client.streaming_recognize(requests=request_iter())
            try:
                for response in responses:
                    for result in response.results:
                        if not result.alternatives:
                            continue
                        text = self._apply_corrections(
                            (result.alternatives[0].transcript or "").strip()
                        )
                        if not text:
                            continue
                        is_final = bool(result.is_final)
                        if is_final:
                            for idx, alt in enumerate(result.alternatives):
                                conf = getattr(alt, "confidence", 0.0)
                                logger.info(
                                    "[STT v1 스트리밍 후보 %d] (confidence=%.3f) %s",
                                    idx, conf, (alt.transcript or "").strip(),
                                )
                            session.final_parts.append(text)
                        session.result_q.put(StreamingResult(text=text, is_final=is_final))
            except Exception as exc:
                logger.exception("GCP v1 스트리밍 STT 응답 처리 실패 [%s]", session.key)
                session.result_q.put(StreamingResult(text="", is_final=True, error=str(exc)))
        except Exception as exc:  # pragma: no cover
            logger.exception("GCP v1 스트리밍 STT 워커 실패 [%s]", session.key)
            session.result_q.put(StreamingResult(text="", is_final=True, error=str(exc)))
        finally:
            session.closed = True

    def start_stream(
        self,
        stream_key: str,
        language_code: str,
        mime_type: str = "audio/pcm",
        sample_rate_hz: int = 16000,
        phrase_set_references: Optional[List[str]] = None,
        bridge_chunks: Optional[List[bytes]] = None,
    ) -> None:
        with self._stream_lock:
            existing = self._streams.get(stream_key)
            if existing and not existing.closed:
                return
            session = _StreamingSession(
                key=stream_key,
                language_code=language_code or self.default_language,
                sample_rate_hz=sample_rate_hz or 16000,
                mime_type=mime_type or "audio/pcm",
                phrase_set_references=phrase_set_references,
                initial_chunks=list(bridge_chunks or []),
            )
            thread = threading.Thread(
                target=self._stream_worker,
                args=(session,),
                name=f"gcp-stt-{stream_key}",
                daemon=True,
            )
            session.thread = thread
            self._streams[stream_key] = session
            thread.start()

    def push_stream_chunk(self, stream_key: str, chunk: bytes) -> None:
        if not chunk:
            return
        with self._stream_lock:
            session = self._streams.get(stream_key)
        if not session:
            raise RuntimeError(f"Streaming session not found: {stream_key}")
        session.recent_chunks.append(chunk)
        if len(session.recent_chunks) > 12:
            del session.recent_chunks[:-12]
        session.request_q.put(chunk)

    def get_stream_bridge_chunks(self, stream_key: str, max_chunks: int = 8) -> list[bytes]:
        with self._stream_lock:
            session = self._streams.get(stream_key)
        if not session:
            return []
        if max_chunks <= 0:
            return []
        return list(session.recent_chunks[-max_chunks:])

    def should_rotate_stream(self, stream_key: str, max_age_sec: float = 270.0) -> bool:
        """GCP 5분 제한 전에 스트림을 선제 교체해야 하는지 확인."""
        with self._stream_lock:
            session = self._streams.get(stream_key)
        if not session or session.closed:
            return False
        return (time.monotonic() - session.started_at) >= max_age_sec

    def drain_stream_results(self, stream_key: str) -> list[StreamingResult]:
        with self._stream_lock:
            session = self._streams.get(stream_key)
        if not session:
            return []
        out: list[StreamingResult] = []
        while True:
            try:
                out.append(session.result_q.get_nowait())
            except queue.Empty:
                break
        return out

    def finish_stream(
        self,
        stream_key: str,
        join_timeout: float = 8.0,
        warn_on_timeout: bool = False,
    ) -> tuple[list[StreamingResult], Optional[str]]:
        with self._stream_lock:
            session = self._streams.get(stream_key)
        if not session:
            return ([], None)

        if not session.closed:
            session.request_q.put(None)
            if session.thread and session.thread.is_alive():
                session.thread.join(timeout=join_timeout)

        results = self.drain_stream_results(stream_key)
        if session.thread and session.thread.is_alive():
            if warn_on_timeout:
                logger.warning("join 타임아웃 이후에도 스트리밍 STT 스레드가 살아 있음 [%s]", stream_key)
            else:
                logger.debug("스트리밍 STT 스레드가 join 타임아웃 이후에도 살아 있음 [%s]", stream_key)

        transcript = " ".join(part.strip() for part in session.final_parts if part and part.strip()).strip()

        with self._stream_lock:
            self._streams.pop(stream_key, None)

        return (results, transcript or None)

    def close_stream(self, stream_key: str) -> None:
        self.finish_stream(stream_key, join_timeout=2.0, warn_on_timeout=False)

    def close_all_streams(self) -> None:
        with self._stream_lock:
            keys = list(self._streams.keys())
        for key in keys:
            try:
                self.finish_stream(key, join_timeout=2.0, warn_on_timeout=False)
            except Exception:
                logger.exception("스트리밍 STT 세션 종료 실패 [%s]", key)
