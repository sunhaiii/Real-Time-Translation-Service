"""통번역 도메인별 Gemini 번역 서비스."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import google.generativeai as genai

logger = logging.getLogger(__name__)

_DOMAIN_SYSTEM_PROMPTS: dict[str, str] = {
    "bank": (
        "You are a professional interpreter for a bank counseling conversation "
        "between a bank counselor and a customer.\n"
        "- Keep meaning exact and complete.\n"
        "- Preserve politeness/tone appropriate for banking service.\n"
        "- Keep numbers, dates, account/card/product names accurate.\n"
        "- Use correct banking terminology (e.g. interest rate, installment, maturity, deposit).\n"
        "- Do not add explanations or notes.\n"
    ),
    "hospital": (
        "You are a professional medical interpreter for a hospital consultation "
        "between a healthcare provider and a patient.\n"
        "- Keep meaning exact and complete.\n"
        "- Preserve politeness/tone appropriate for a medical setting.\n"
        "- Use accurate medical terminology (e.g. diagnosis, dosage, symptoms, prescription).\n"
        "- Keep numbers, dates, medication names, and dosage information accurate.\n"
        "- Do not add explanations or notes.\n"
    ),
}

_DEFAULT_DOMAIN = "bank"


class TranslatorService:
    """Gemini API 기반 경량 번역 래퍼"""

    def __init__(self) -> None:
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY가 설정되지 않았습니다.")

        model_name = os.getenv("GEMINI_MODEL_TEXT", "gemini-2.5-flash-lite")
        self._semaphore = asyncio.Semaphore(
            max(1, int((os.getenv("QSTT_TRANSLATE_CONCURRENCY") or "4").strip() or "4"))
        )
        genai.configure(api_key=api_key)
        self.model = genai.GenerativeModel(model_name)
        logger.info("번역기가 초기화되었습니다 (모델=%s)", model_name)

    def _lang_name(self, code: str) -> str:
        names = {
            "ko-KR": "Korean",
            "ko": "Korean",
            "en-US": "English",
            "en": "English",
            "en-SG": "English (Singapore)",
            "zh-CN": "Chinese",
            "zh": "Chinese (Simplified)",
            "zh-HK": "Cantonese (Hong Kong)",
            "yue-Hant-HK": "Cantonese (Hong Kong)",
            "vi-VN": "Vietnamese",
            "vi": "Vietnamese",
            "th-TH": "Thai",
            "th": "Thai",
            "id-ID": "Indonesian",
            "id": "Indonesian",
            "tl-PH": "Tagalog",
            "tl": "Tagalog",
            "uz-UZ": "Uzbek",
            "uz": "Uzbek",
            "ja-JP": "Japanese",
            "ja": "Japanese",
        }
        return names.get(code, code or "Unknown")

    async def translate(
        self,
        text: str,
        source_lang: str = "ko-KR",
        target_lang: str = "en-US",
        domain: str = _DEFAULT_DOMAIN,
    ) -> Optional[str]:
        """상담 대화내용 번역. domain에 따라 bank/hospital 전문 번역 프롬프트 적용."""
        try:
            if not text or not text.strip():
                return None

            if source_lang == target_lang:
                return text

            source_name = self._lang_name(source_lang)
            target_name = self._lang_name(target_lang)
            source_text = text.strip()

            system_prompt = _DOMAIN_SYSTEM_PROMPTS.get(domain, _DOMAIN_SYSTEM_PROMPTS[_DEFAULT_DOMAIN])

            prompt = (
                f"{system_prompt}\n"
                f"Translate from {source_name} to {target_name}.\n\n"
                f"Rules:\n"
                f"- Output only the {target_name} translation.\n\n"
                f"Source ({source_name}):\n{source_text}\n\n"
                f"Translation ({target_name}):"
            )

            async with self._semaphore:
                response = await asyncio.to_thread(self.model.generate_content, prompt)
            translated_text = (getattr(response, "text", "") or "").strip()
            if not translated_text:
                return None

            logger.info("번역 완료: %s -> %s (domain=%s)", source_lang, target_lang, domain)
            return translated_text
        except Exception as e:
            logger.error("번역 오류: %s", e)
            return None

    def get_supported_languages(self):
        return [
            "ko-KR",
            "zh-CN",
            "vi-VN",
            "th-TH",
            "en-US",
            "uz-UZ",
            "tl-PH",
            "id-ID",
            "ja-JP",
            "zh-HK",
            "en-SG",
        ]

    def get_supported_language_pairs(self):
        langs = self.get_supported_languages()
        return [(s, t) for s in langs for t in langs if s != t]
