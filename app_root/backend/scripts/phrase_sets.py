import json
import os
from pathlib import Path

# backend/ 기준 경로 (이 스크립트는 backend/scripts/phrase_sets.py 에 있음)
_SCRIPT_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _SCRIPT_DIR.parent

# backend/.env 를 로드 (GOOGLE_APPLICATION_CREDENTIALS=credentials.json 등)
_dotenv_path = _BACKEND_DIR / ".env"
if _dotenv_path.exists():
    import dotenv
    dotenv.load_dotenv(_dotenv_path)

# .env 의 credentials.json 은 backend 기준 상대 경로 → 절대 경로로 고정 (실행 cwd 와 무관하게)
_creds_env = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
if _creds_env and not Path(_creds_env).is_absolute():
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str((_BACKEND_DIR / _creds_env).resolve())
elif not _creds_env and (_BACKEND_DIR / "credentials.json").exists():
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str((_BACKEND_DIR / "credentials.json").resolve())

from google.cloud.speech_v2 import SpeechClient
from google.cloud.speech_v2.types import cloud_speech
from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import AlreadyExists, NotFound


def _get_credentials_path() -> str:
    """credentials.json 의 절대 경로. 없으면 backend/credentials.json 기준."""
    creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_path:
        creds_path = str(_BACKEND_DIR / "credentials.json")
    return str(Path(creds_path).resolve())


def _load_project_id() -> str:
    """credentials.json 에서 project_id를 읽어 반환합니다."""
    creds_path = _get_credentials_path()
    with open(creds_path, encoding="utf-8") as f:
        data = json.load(f)
    project_id = data.get("project_id")
    if not project_id:
        raise ValueError(f"credentials.json 에 project_id 필드가 없습니다: {creds_path}")
    return project_id


def _build_phrases(phrases: list[dict]) -> list:
    return [
        cloud_speech.PhraseSet.Phrase(value=item["value"], boost=item.get("boost", 0.0))
        for item in phrases
    ]


def create_phrase_set(
    client: SpeechClient,
    project_id: str,
    location: str,
    phrase_set_id: str,
    phrases: list[dict],
):
    parent = f"projects/{project_id}/locations/{location}"
    phrase_set = cloud_speech.PhraseSet(phrases=_build_phrases(phrases))

    try:
        request = cloud_speech.CreatePhraseSetRequest(
            parent=parent,
            phrase_set_id=phrase_set_id,
            phrase_set=phrase_set,
        )
        operation = client.create_phrase_set(request=request)
        result = operation.result()
        print(f"[생성 완료] {result.name}")
        return result.name
    except AlreadyExists:
        existing_name = f"{parent}/phraseSets/{phrase_set_id}"
        print(f"[이미 존재함] {existing_name}")
        return existing_name


def update_phrase_set(
    client: SpeechClient,
    project_id: str,
    location: str,
    phrase_set_id: str,
    phrases: list[dict],
):
    """기존 PhraseSet의 phrases를 덮어쓰기 (수정)."""
    name = f"projects/{project_id}/locations/{location}/phraseSets/{phrase_set_id}"
    phrase_set = cloud_speech.PhraseSet(
        name=name,
        phrases=_build_phrases(phrases),
    )
    from google.protobuf import field_mask_pb2
    update_mask = field_mask_pb2.FieldMask(paths=["phrases"])
    request = cloud_speech.UpdatePhraseSetRequest(
        phrase_set=phrase_set,
        update_mask=update_mask,
    )
    operation = client.update_phrase_set(request=request)
    result = operation.result()
    print(f"[수정 완료] {result.name}  (phrases {len(phrases)}개)")
    return result.name


def delete_phrase_set(
    client: SpeechClient,
    project_id: str,
    location: str,
    phrase_set_id: str,
):
    """PhraseSet 삭제."""
    name = f"projects/{project_id}/locations/{location}/phraseSets/{phrase_set_id}"
    try:
        request = cloud_speech.DeletePhraseSetRequest(name=name)
        client.delete_phrase_set(request=request)
        print(f"[삭제 완료] {name}")
    except NotFound:
        print(f"[삭제 대상 없음] {name}")


def create_or_update_phrase_set(
    client: SpeechClient,
    project_id: str,
    location: str,
    phrase_set_id: str,
    phrases: list[dict],
):
    """PhraseSet이 없으면 생성, 있으면 수정."""
    parent = f"projects/{project_id}/locations/{location}"
    phrase_set = cloud_speech.PhraseSet(phrases=_build_phrases(phrases))

    try:
        request = cloud_speech.CreatePhraseSetRequest(
            parent=parent,
            phrase_set_id=phrase_set_id,
            phrase_set=phrase_set,
        )
        operation = client.create_phrase_set(request=request)
        result = operation.result()
        print(f"[생성 완료] {result.name}")
        return result.name
    except AlreadyExists:
        return update_phrase_set(client, project_id, location, phrase_set_id, phrases)


def main():
    project_id = _load_project_id()
    # Chirp 3 recognizer 와 동일한 리전을 사용해야 PhraseSet 참조가 수락됨.
    # us 엔드포인트 클라이언트로 us 리전에 PhraseSet 을 생성.
    location = (
        os.getenv("GCP_STT_V2_LOCATION")
        or os.getenv("GCP_STT_LOCATION")
        or "us"
    ).strip()
    api_endpoint = f"{location}-speech.googleapis.com"

    client = SpeechClient(
        client_options=ClientOptions(api_endpoint=api_endpoint)
    )

    # 1) 숫자용 PhraseSet
    number_phrases = [
        {"value": "계좌번호", "boost": 10.0},
        {"value": "비밀번호", "boost": 10.0},
        {"value": "번호표", "boost": 10.0},
        {"value": "대기번호", "boost": 10.0},
        {"value": "인증번호", "boost": 10.0},
        {"value": "송금번호", "boost": 10.0},
        {"value": "카드번호", "boost": 10.0},
        {"value": "비자번호", "boost": 10.0},
        {"value": "여권번호", "boost": 10.0},
        {"value": "등록번호", "boost": 10.0},
        {"value": "주민등록번호", "boost": 10.0},
        {"value": "외국인등록번호", "boost": 10.0},
        {"value": "고객번호", "boost": 10.0},
        {"value": "거래번호", "boost": 10.0},
        {"value": "접수번호", "boost": 10.0},
        {"value": "승인번호", "boost": 10.0},
        {"value": "보안번호", "boost": 10.0},
        {"value": "OTP 번호", "boost": 10.0},
        {"value": "전화번호", "boost": 10.0},
        {"value": "휴대폰번호", "boost": 10.0},
        {"value": "우편번호", "boost": 10.0},
        {"value": "금액", "boost": 10.0},
        {"value": "잔액", "boost": 10.0},
        {"value": "이자", "boost": 10.0},
        {"value": "원금", "boost": 10.0},
        {"value": "원리금", "boost": 10.0},
        {"value": "수수료", "boost": 10.0},
        {"value": "한도", "boost": 10.0},
        {"value": "이용한도", "boost": 10.0},
        {"value": "이체한도", "boost": 10.0},
        {"value": "출금한도", "boost": 10.0},
        {"value": "대출한도", "boost": 10.0},
        {"value": "금리", "boost": 10.0},
        {"value": "변동금리", "boost": 10.0},
        {"value": "고정금리", "boost": 10.0},
        {"value": "연체이자", "boost": 10.0},
        {"value": "환율", "boost": 10.0},
        {"value": "매매기준율", "boost": 10.0},
        {"value": "LTV", "boost": 10.0},
        {"value": "DTI", "boost": 10.0},
        {"value": "DSR", "boost": 10.0},
        {"value": "만기일", "boost": 10.0},
        {"value": "개설일", "boost": 10.0},
        {"value": "출금일", "boost": 10.0},
        {"value": "출금가능금액", "boost": 10.0},
    ]

    # 2) 문자용 PhraseSet
    alphabet_phrases = [
        {"value": "영문 이름", "boost": 8.0},
        {"value": "계좌", "boost": 8.0},
        {"value": "통장", "boost": 8.0},
        {"value": "입출금", "boost": 8.0},
        {"value": "입금", "boost": 8.0},
        {"value": "출금", "boost": 8.0},
        {"value": "이체", "boost": 8.0},
        {"value": "송금", "boost": 8.0},
        {"value": "거래내역", "boost": 8.0},
        {"value": "예금", "boost": 8.0},
        {"value": "적금", "boost": 8.0},
        {"value": "정기예금", "boost": 10.0},
        {"value": "정기적금", "boost": 10.0},
        {"value": "자유적금", "boost": 8.0},
        {"value": "해지", "boost": 8.0},
        {"value": "만기", "boost": 8.0},
        {"value": "자동이체", "boost": 8.0},
        {"value": "출금계좌", "boost": 8.0},
        {"value": "입금계좌", "boost": 8.0},
        {"value": "보안카드", "boost": 8.0},
        {"value": "OTP", "boost": 8.0},
        {"value": "공동인증서", "boost": 8.0},
        {"value": "신분증", "boost": 8.0},
        {"value": "본인확인", "boost": 8.0},
        {"value": "서명", "boost": 8.0},
        {"value": "창구", "boost": 8.0},
        {"value": "상담", "boost": 8.0},
        {"value": "신청서", "boost": 8.0},
        {"value": "약관", "boost": 8.0},
        {"value": "체크카드", "boost": 8.0},
        {"value": "신용카드", "boost": 8.0},
        {"value": "직불카드", "boost": 8.0},
        {"value": "카드발급", "boost": 8.0},
        {"value": "재발급", "boost": 8.0},
        {"value": "분실신고", "boost": 8.0},
        {"value": "해외사용", "boost": 8.0},
        {"value": "환전", "boost": 8.0},
        {"value": "외화", "boost": 8.0},
        {"value": "외화계좌", "boost": 8.0},
        {"value": "대출", "boost": 8.0},
        {"value": "신용대출", "boost": 8.0},
        {"value": "담보대출", "boost": 8.0},
        {"value": "주택담보대출", "boost": 8.0},
        {"value": "상환", "boost": 8.0},
        {"value": "연체", "boost": 8.0},
        {"value": "보증인", "boost": 8.0},
        {"value": "담보", "boost": 8.0},
        {"value": "대환대출", "boost": 8.0},
        {"value": "분할상환", "boost": 8.0},
        {"value": "원리금 균등상환", "boost": 8.0},
        {"value": "원금 균등상환", "boost": 8.0},
        {"value": "보증보험", "boost": 8.0},
        {"value": "대손충당금", "boost": 8.0},
        {"value": "인터넷뱅킹", "boost": 8.0},
        {"value": "모바일뱅킹", "boost": 8.0},
        {"value": "공인인증", "boost": 8.0},
        {"value": "로그인", "boost": 8.0},
        {"value": "회원가입", "boost": 8.0},
        {"value": "조회", "boost": 8.0},
        {"value": "납부", "boost": 8.0},
        {"value": "공과금", "boost": 8.0},
        {"value": "영업점", "boost": 8.0},
        {"value": "지점", "boost": 8.0},
        {"value": "고객센터", "boost": 8.0},
        {"value": "처리중", "boost": 8.0},
        {"value": "완료", "boost": 8.0},
        {"value": "증명서", "boost": 8.0},
        {"value": "거래확인서", "boost": 8.0},
        {"value": "잔액증명서", "boost": 8.0},
        {"value": "통장정리", "boost": 8.0},
        {"value": "계좌개설", "boost": 8.0},
        {"value": "계좌해지", "boost": 8.0},
        {"value": "휴면계좌", "boost": 8.0},
        {"value": "압류", "boost": 8.0},
        {"value": "지급정지", "boost": 8.0},
        {"value": "사본", "boost": 8.0},
        {"value": "원본", "boost": 8.0},
        {"value": "외국인등록증", "boost": 8.0},
        {"value": "여권", "boost": 8.0},
        {"value": "체류자격", "boost": 8.0},
        {"value": "소득증빙", "boost": 8.0},
        {"value": "재직증명서", "boost": 8.0},
        {"value": "거래목적", "boost": 8.0},
        {"value": "금융사기", "boost": 8.0},
        {"value": "이상거래", "boost": 8.0},
        {"value": "본인명의", "boost": 8.0},
        {"value": "예금주", "boost": 8.0},
        {"value": "수취인", "boost": 8.0},
        {"value": "보내는사람", "boost": 8.0},
        {"value": "받는사람", "boost": 8.0},
        {"value": "수취계좌", "boost": 8.0},
        {"value": "중도해지", "boost": 8.0},
        {"value": "우대금리", "boost": 8.0},
        {"value": "입금자명", "boost": 8.0},
        {"value": "복리", "boost": 8.0},
        {"value": "단리", "boost": 8.0},
        {"value": "비과세예금", "boost": 8.0},
        {"value": "마이너스 통장", "boost": 8.0},
        {"value": "입출금내역서", "boost": 8.0},
        {"value": "예금자보호제도", "boost": 8.0},
        {"value": "한도초과", "boost": 8.0},
        {"value": "리볼빙", "boost": 8.0},
        {"value": "무이자할부", "boost": 8.0},
        {"value": "포인트 적립", "boost": 8.0},
        {"value": "자동결제", "boost": 8.0},
        {"value": "인터넷전문은행", "boost": 8.0},
        {"value": "모바일전용계좌", "boost": 8.0},
        {"value": "간편이체", "boost": 8.0},
        {"value": "핀테크", "boost": 8.0},
        {"value": "토스", "boost": 8.0},
        {"value": "카카오뱅크", "boost": 8.0},
        {"value": "케이뱅크", "boost": 8.0},
        {"value": "오픈뱅킹", "boost": 8.0},
        {"value": "전자어음", "boost": 8.0},
        {"value": "가상계좌", "boost": 8.0},
        {"value": "외환예금", "boost": 8.0},
        {"value": "SWIFT 코드", "boost": 8.0},
        {"value": "외환거래", "boost": 8.0},
        {"value": "해외결제 수수료", "boost": 8.0},
        {"value": "외화환율우대", "boost": 8.0},
        {"value": "ISA", "boost": 8.0},
        {"value": "펀드", "boost": 8.0},
        {"value": "연금저축", "boost": 8.0},
        {"value": "국민연금", "boost": 8.0},
        {"value": "퇴직연금", "boost": 8.0},
        {"value": "IRP", "boost": 8.0},
        {"value": "DC형", "boost": 8.0},
        {"value": "DB형", "boost": 8.0},
        {"value": "개인연금", "boost": 8.0},
        {"value": "연금보험", "boost": 8.0},
        {"value": "배당주 투자", "boost": 8.0},
        {"value": "ETF", "boost": 8.0},
        {"value": "ELS", "boost": 8.0},
        {"value": "CMA", "boost": 8.0},
        {"value": "리츠", "boost": 8.0},
        {"value": "MMF", "boost": 8.0},
        {"value": "CD", "boost": 8.0},
        {"value": "P2P 금융", "boost": 8.0},
        {"value": "생명보험", "boost": 8.0},
        {"value": "건강보험", "boost": 8.0},
        {"value": "자동차 보험", "boost": 8.0},
        {"value": "연금 보험", "boost": 8.0},
    ]

    number_name = create_or_update_phrase_set(
        client=client,
        project_id=project_id,
        location=location,
        phrase_set_id="number-biasing",
        phrases=number_phrases,
    )

    alphabet_name = create_or_update_phrase_set(
        client=client,
        project_id=project_id,
        location=location,
        phrase_set_id="alphabet-biasing",
        phrases=alphabet_phrases,
    )

    print("\n=== 사용할 PhraseSet references ===")
    print(number_name)
    print(alphabet_name)

    print("\n=== 환경변수 예시 ===")
    print(
        "GCP_STT_PHRASE_SET_REFERENCES="
        f'"{number_name},{alphabet_name}"'
    )


if __name__ == "__main__":
    main()
