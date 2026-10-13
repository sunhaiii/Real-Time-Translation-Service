"""
SQLite3 데이터베이스 서비스
채팅방(chat_sessions)과 메시지(chat_messages) — 세션·채팅방 번호·언어·발신 시각 반영
word_dictionary — 도메인별 STT 보정 용어 사전
"""
import sqlite3
import os
import sys
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

# 한국 시간 (KST, UTC+9)
KST = timezone(timedelta(hours=9))

logger = logging.getLogger(__name__)


def _resolve_db_path() -> str:
    """PyInstaller 등으로 묶인 exe는 임시 폴더가 아니라 exe가 있는 디렉터리에 DB를 둔다."""
    if getattr(sys, "frozen", False):
        base = os.path.dirname(os.path.abspath(sys.executable))
    else:
        base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    return os.path.join(base, "qstt.db")


DB_PATH = _resolve_db_path()

# 도메인별 초기 시드 데이터
_SEED_TERMS: dict[str, list[str]] = {
    "bank": [
        # 예금·적금
        "정기예금", "정기적금", "자유적금", "보통예금", "저축예금",
        "비과세예금", "외화예금", "예금주", "예금자보호",
        # 계좌
        "계좌번호", "계좌개설", "계좌해지", "입금계좌", "출금계좌",
        "수취계좌", "가상계좌", "휴면계좌", "외화계좌", "모바일전용계좌",
        # 거래
        "거래내역", "거래번호", "거래확인서", "거래목적", "이상거래",
        # 이체·송금
        "자동이체", "간편이체", "송금번호",
        # 대출
        "신용대출", "담보대출", "주택담보대출", "대환대출", "대출한도",
        "분할상환", "원리금", "원금", "연체이자",
        "원리금균등상환", "원금균등상환",
        # 카드
        "체크카드", "신용카드", "직불카드", "카드발급", "카드번호",
        "보안카드", "무이자할부", "리볼빙",
        # 금리·수수료
        "금리", "변동금리", "고정금리", "우대금리", "수수료",
        "매매기준율", "환율",
        # 한도
        "이용한도", "이체한도", "출금한도", "한도초과",
        # 인증·보안
        "인증번호", "비밀번호", "공동인증서", "공인인증", "본인확인",
        # 증명서
        "잔액증명서", "재직증명서", "소득증빙",
        # 기타 금융
        "중도해지", "만기일", "개설일", "연금저축", "퇴직연금",
        "인터넷뱅킹", "모바일뱅킹",
        "주민등록번호", "외국인등록번호", "외국인등록증",
    ],
    "hospital": [
        # 진료
        "외래진료", "입원수속", "응급실", "진료예약", "진료과",
        "초진", "재진", "진료비", "진료기록",
        # 검사
        "혈액검사", "엑스레이", "CT검사", "MRI검사", "초음파검사",
        "심전도", "소변검사", "내시경검사",
        # 처방·약
        "처방전", "처방약", "복용량", "투약", "주사",
        "항생제", "진통제", "혈압약", "당뇨약", "인슐린",
        # 병명·증상
        "고혈압", "당뇨병", "당뇨", "고지혈증", "심근경색",
        "뇌졸중", "폐렴", "위염", "대장염", "관절염",
        "골절", "탈골", "디스크", "요통", "두통", "발열",
        # 수술·시술
        "수술동의서", "마취", "전신마취", "국소마취", "봉합",
        "내시경수술", "복강경", "절개",
        # 입퇴원
        "입원", "퇴원", "입원비", "병실", "1인실", "다인실",
        "퇴원요약지", "진단서", "소견서",
        # 보험
        "건강보험", "실손보험", "본인부담금", "급여항목", "비급여",
        # 의료진
        "주치의", "담당의", "간호사", "의사",
    ],
}


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    """Create required tables, indexes, and seed data if they do not exist."""
    conn = _get_conn()
    try:
        conn.executescript("""

            CREATE TABLE IF NOT EXISTS chat_sessions (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id         TEXT    NOT NULL,
                customer_name      TEXT,
                device_id          TEXT,
                room_number        INTEGER NOT NULL,
                counselor_lang     TEXT,
                client_lang        TEXT,
                title              TEXT    NOT NULL DEFAULT '새 채팅',
                domain             TEXT    NOT NULL DEFAULT 'bank',
                UNIQUE(session_id, room_number)
            );

            CREATE INDEX IF NOT EXISTS idx_chat_sessions_session
                ON chat_sessions (session_id);

            CREATE TABLE IF NOT EXISTS chat_messages (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                sender             TEXT    NOT NULL,
                request_id         TEXT,
                counselor_lang_text TEXT    NOT NULL DEFAULT '',
                client_lang_text   TEXT    NOT NULL DEFAULT '',
                sent_at   DATETIME
            );

            CREATE INDEX IF NOT EXISTS idx_chat_messages_session
                ON chat_messages (chat_session_id);

            CREATE TABLE IF NOT EXISTS chat_audio_segments (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                sender             TEXT    NOT NULL,
                request_id         TEXT,
                mime_type          TEXT    NOT NULL DEFAULT 'audio/wav',
                sample_rate_hz     INTEGER NOT NULL DEFAULT 16000,
                gcs_uri            TEXT    NOT NULL,
                byte_length        INTEGER NOT NULL DEFAULT 0,
                duration_ms        INTEGER NOT NULL DEFAULT 0,
                started_at_ms      INTEGER,
                ended_at_ms        INTEGER,
                created_at         DATETIME NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chat_audio_segments_session
                ON chat_audio_segments (chat_session_id, created_at);

            CREATE TABLE IF NOT EXISTS word_dictionary (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT    NOT NULL,
                term   TEXT    NOT NULL,
                UNIQUE(domain, term)
            );

            CREATE INDEX IF NOT EXISTS idx_word_dictionary_domain
                ON word_dictionary (domain);

        """)

        # 기존 chat_sessions 테이블에 domain 컬럼이 없으면 추가 (마이그레이션)
        try:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN domain TEXT NOT NULL DEFAULT 'bank'")
            conn.commit()
            logger.info("chat_sessions.domain 컬럼 마이그레이션 완료")
        except Exception:
            pass  # 이미 존재하는 경우 무시
        try:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN device_id TEXT")
            conn.commit()
            logger.info("chat_sessions.device_id 컬럼 마이그레이션 완료")
        except Exception:
            pass  # 이미 존재하는 경우 무시
        try:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN customer_name TEXT")
            conn.commit()
            logger.info("chat_sessions.customer_name 컬럼 마이그레이션 완료")
        except Exception:
            pass  # 이미 존재하는 경우 무시
        try:
            conn.execute("ALTER TABLE chat_messages ADD COLUMN request_id TEXT")
            conn.commit()
            logger.info("chat_messages.request_id 컬럼 마이그레이션 완료")
        except Exception:
            pass  # 이미 존재하는 경우 무시

        # 도메인 용어 시드 (INSERT OR IGNORE로 멱등)
        for domain, terms in _SEED_TERMS.items():
            conn.executemany(
                "INSERT OR IGNORE INTO word_dictionary (domain, term) VALUES (?, ?)",
                [(domain, t) for t in terms],
            )
        conn.commit()
        logger.info(f"DB 초기화 완료(새 스키마): {DB_PATH}")
    finally:
        conn.close()


def create_chat(
    session_id: str,
    title: Optional[str] = None,
    customer_name: Optional[str] = None,
    device_id: Optional[str] = None,
    counselor_lang: Optional[str] = None,
    client_lang: Optional[str] = None,
    domain: str = "bank",
) -> int:
    """세션별 공유 채팅방 1개 생성. room_number는 해당 세션 내 자동 부여(1,2,3...)."""
    if not title:
        title = datetime.now(KST).strftime("%Y.%m.%d") + " 상담"
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT COALESCE(MAX(room_number), 0) + 1 AS next FROM chat_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        next_num = row["next"] if row else 1
        cur = conn.execute(
            """INSERT INTO chat_sessions (session_id, customer_name, device_id, room_number, counselor_lang, client_lang, title, domain)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, customer_name, device_id, next_num, counselor_lang, client_lang, title, domain),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_chats(session_id: str) -> list[dict]:
    """session_id 기준 채팅방 목록 (최신 순). room_number, customer_name, device_id, counselor_lang, client_lang, domain 포함."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT id, session_id, customer_name, device_id, room_number,
                   counselor_lang, client_lang,
                   title, domain
            FROM chat_sessions
            WHERE session_id = ?
            ORDER BY id DESC
            """,
            (session_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def update_chat_title(chat_id: int, title: str) -> None:
    """채팅방 제목 갱신"""
    conn = _get_conn()
    try:
        conn.execute(
            "UPDATE chat_sessions SET title = ? WHERE id = ?",
            (title, chat_id),
        )
        conn.commit()
    finally:
        conn.close()


def update_chat_languages(
    chat_id: int,
    counselor_lang: Optional[str] = None,
    client_lang: Optional[str] = None,
) -> None:
    """채팅방 언어 설정 갱신 (선택 사항)"""
    conn = _get_conn()
    try:
        if counselor_lang is not None:
            conn.execute(
                "UPDATE chat_sessions SET counselor_lang = ? WHERE id = ?",
                (counselor_lang, chat_id),
            )
        if client_lang is not None:
            conn.execute(
                "UPDATE chat_sessions SET client_lang = ? WHERE id = ?",
                (client_lang, chat_id),
            )
        conn.commit()
    finally:
        conn.close()


def add_message(
    chat_id: int,
    sender: str,
    request_id: Optional[str],
    original_text: str,
    translated_text: Optional[str],
    source_lang: Optional[str],
    target_lang: Optional[str],
) -> int:
    """
    메시지 저장.
    - sender=counselor: counselor_lang_text=원문, client_lang_text=번역, sent_at=now
    - sender=client: client_lang_text=원문, counselor_lang_text=번역, sent_at=now
    - source_lang/target_lang은 chat_sessions.counselor_lang/client_lang
    """
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    conn = _get_conn()
    try:
        if sender == "counselor":
            counselor_text = original_text or ""
            client_text = (translated_text or original_text or "").strip() or ""
        else:
            client_text = original_text or ""
            counselor_text = (translated_text or original_text or "").strip() or ""

        cur = conn.execute(
            """
            INSERT INTO chat_messages (
                chat_session_id, sender, request_id, counselor_lang_text, client_lang_text, sent_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (chat_id, sender, request_id, counselor_text, client_text, now),
        )

        if source_lang or target_lang:
            if sender == "counselor":
                conn.execute(
                    """
                    UPDATE chat_sessions
                    SET counselor_lang = COALESCE(?, counselor_lang),
                        client_lang = COALESCE(?, client_lang)
                    WHERE id = ?
                    """,
                    (source_lang or None, target_lang or None, chat_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE chat_sessions
                    SET client_lang = COALESCE(?, client_lang),
                        counselor_lang = COALESCE(?, counselor_lang)
                    WHERE id = ?
                    """,
                    (source_lang or None, target_lang or None, chat_id),
                )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_messages(chat_id: int) -> list[dict]:
    """채팅방 메시지 목록 (오래된 순). request_id, counselor_lang_text, client_lang_text, sent_at 포함."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT id, sender, request_id, counselor_lang_text, client_lang_text, sent_at
            FROM chat_messages
            WHERE chat_session_id = ?
            ORDER BY sent_at ASC
            """,
            (chat_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def add_audio_segment(
    chat_id: int,
    sender: str,
    request_id: Optional[str],
    mime_type: str,
    sample_rate_hz: int,
    gcs_uri: str,
    byte_length: int,
    duration_ms: int,
    started_at_ms: Optional[int] = None,
    ended_at_ms: Optional[int] = None,
) -> int:
    """음성 세그먼트 메타데이터 저장 (원본 오디오는 GCS URI로 관리)."""
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    conn = _get_conn()
    try:
        cur = conn.execute(
            """
            INSERT INTO chat_audio_segments (
                chat_session_id, sender, request_id, mime_type, sample_rate_hz, gcs_uri,
                byte_length, duration_ms, started_at_ms, ended_at_ms, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chat_id,
                sender,
                request_id,
                mime_type,
                int(sample_rate_hz or 16000),
                gcs_uri,
                int(byte_length or 0),
                int(duration_ms or 0),
                started_at_ms,
                ended_at_ms,
                now,
            ),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_audio_segments(chat_id: int) -> list[dict]:
    """채팅방 음성 세그먼트 목록 조회 (최신순)."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT id, chat_session_id, sender, request_id, mime_type, sample_rate_hz,
                   gcs_uri, byte_length, duration_ms, started_at_ms, ended_at_ms, created_at
            FROM chat_audio_segments
            WHERE chat_session_id = ?
            ORDER BY created_at DESC, id DESC
            """,
            (chat_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_chat_session_id(chat_id: int) -> Optional[str]:
    """채팅방의 session_id 반환 (삭제 후 브로드캐스트용)"""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT session_id FROM chat_sessions WHERE id = ?",
            (chat_id,),
        ).fetchone()
        return row["session_id"] if row else None
    finally:
        conn.close()


def delete_chat(chat_id: int) -> None:
    """채팅방 삭제 (메시지 CASCADE 삭제)"""
    conn = _get_conn()
    try:
        conn.execute("DELETE FROM chat_sessions WHERE id = ?", (chat_id,))
        conn.commit()
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────
# 도메인 용어 사전 CRUD
# ──────────────────────────────────────────────────────────────

def get_domain_terms(domain: str) -> list[dict]:
    """도메인 용어 목록 조회 (알파벳/가나다 순)."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT id, domain, term FROM word_dictionary WHERE domain = ? ORDER BY term ASC",
            (domain,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def add_domain_term(domain: str, term: str) -> int:
    """도메인 용어 추가. UNIQUE 충돌 시 기존 id 반환."""
    conn = _get_conn()
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO word_dictionary (domain, term) VALUES (?, ?)",
            (domain, term.strip()),
        )
        conn.commit()
        if cur.lastrowid:
            return cur.lastrowid
        row = conn.execute(
            "SELECT id FROM word_dictionary WHERE domain = ? AND term = ?",
            (domain, term.strip()),
        ).fetchone()
        return row["id"] if row else 0
    finally:
        conn.close()


def delete_domain_term(term_id: int) -> None:
    """도메인 용어 삭제."""
    conn = _get_conn()
    try:
        conn.execute("DELETE FROM word_dictionary WHERE id = ?", (term_id,))
        conn.commit()
    finally:
        conn.close()
