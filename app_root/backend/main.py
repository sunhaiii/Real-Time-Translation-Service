"""
실시간 통역 시스템 - FastAPI Backend with WebSocket
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
import asyncio
import json
import os
import base64
import logging
import subprocess
import sys
import time
import uuid
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict
from services.database import (
    init_db, create_chat, get_chats, update_chat_title,
    add_message, get_messages, get_chat_session_id, delete_chat,
    get_domain_terms, add_domain_term, delete_domain_term,
    add_audio_segment, get_audio_segments,
)

# 환경 변수 로드 (PyInstaller 단일 exe: exe와 같은 폴더의 .env)
if getattr(sys, "frozen", False):
    load_dotenv(Path(sys.executable).resolve().parent / ".env")
else:
    load_dotenv()

# 로깅 설정
_log_fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
_root_logger = logging.getLogger()
_root_logger.setLevel(logging.INFO)

_stream_handler = logging.StreamHandler(sys.stdout)
_stream_handler.setFormatter(_log_fmt)
_root_logger.addHandler(_stream_handler)

# PyInstaller(frozen) 또는 QSTT_APP_ROOT 환경 변수가 있을 때 파일 핸들러 추가
# → backend.exe가 런처 없이 직접 실행되는 경우에도 qstt-backend.log에 기록됨
try:
    if getattr(sys, "frozen", False):
        _log_dir = Path(sys.executable).resolve().parent
    else:
        _raw_root = os.environ.get("QSTT_APP_ROOT")
        _log_dir = Path(_raw_root).resolve() if _raw_root else None

    if _log_dir:
        _file_handler = logging.FileHandler(
            _log_dir / "qstt-backend.log", encoding="utf-8"
        )
        _file_handler.setFormatter(_log_fmt)
        _root_logger.addHandler(_file_handler)
except Exception:
    pass

logger = logging.getLogger(__name__)
DEVICE_ID = (os.getenv("QSTT_MACHINE_ID") or "").strip() or "unknown-device"
CUSTOMER_NAME = (os.getenv("QSTT_CUSTOMER_NAME") or "").strip() or "unknown-customer"

# FastAPI 앱 생성
app = FastAPI(
    title="실시간 통역 시스템",
    description="한국 상담사 ↔ 외국인 고객 실시간 음성 통역 서비스",
    version="1.0.0"
)

# CORS 설정 - WebSocket 지원을 위해 모든 origin 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# DB 초기화 (앱 시작 시 테이블 생성)
init_db()


# WebSocket 연결 관리자
class ConnectionManager:
    """WebSocket 연결을 관리하는 클래스 (같은 세션의 여러 연결 지원)"""
    
    def __init__(self):
        # session_id -> List[WebSocket] 매핑
        self.active_connections: Dict[str, list] = {}
    
    async def connect(self, session_id: str, websocket: WebSocket):
        """새로운 WebSocket 연결 수락"""
        await websocket.accept()
        
        if session_id not in self.active_connections:
            self.active_connections[session_id] = []
        
        self.active_connections[session_id].append(websocket)
        total_connections = sum(len(conns) for conns in self.active_connections.values())
        logger.info(f"✅ 클라이언트 연결: {session_id} (세션 내 {len(self.active_connections[session_id])}개, 전체 {total_connections}개)")
    
    def disconnect(self, session_id: str, websocket: WebSocket):
        """WebSocket 연결 종료"""
        if session_id in self.active_connections:
            try:
                self.active_connections[session_id].remove(websocket)
                if not self.active_connections[session_id]:
                    del self.active_connections[session_id]
            except ValueError:
                pass
            
            total_connections = sum(len(conns) for conns in self.active_connections.values())
            logger.info(f"❌ 클라이언트 연결 종료: {session_id} (전체 {total_connections}개)")
    
    async def send_message(self, session_id: str, message: dict):
        """특정 세션의 모든 연결에 메시지 브로드캐스트"""
        if session_id in self.active_connections:
            disconnected = []
            for websocket in self.active_connections[session_id]:
                try:
                    await websocket.send_json(message)
                except Exception as e:
                    logger.error(f"메시지 전송 실패 [{session_id}]: {e}")
                    disconnected.append(websocket)
            
            # 실패한 연결 제거
            for ws in disconnected:
                self.disconnect(session_id, ws)
            
            if self.active_connections.get(session_id):
                logger.debug(f"📤 메시지 브로드캐스트 [{session_id}]: {message.get('type', 'unknown')} → {len(self.active_connections[session_id])}개 연결")


manager = ConnectionManager()
SPEAKER_LOCK_SEC = float((os.getenv("QSTT_SPEAKER_LOCK_SEC") or "0.5").strip() or "0.5")
SPEAKER_RELEASE_GRACE_SEC = float((os.getenv("QSTT_SPEAKER_RELEASE_GRACE_SEC") or "0.10").strip() or "0.10")
_speaker_locks_by_session: Dict[str, Dict[str, dict]] = {}
_speaker_locks_guard = asyncio.Lock()


def _speaker_chat_key(chat_id) -> str:
    if chat_id is None:
        return "__default__"
    return str(chat_id)


async def _apply_speaker_lock(
    *,
    session_id: str,
    chat_id,
    sender: str,
    is_speaking: bool,
) -> tuple[str | None, float]:
    now = time.monotonic()
    chat_key = _speaker_chat_key(chat_id)
    async with _speaker_locks_guard:
        session_state = _speaker_locks_by_session.setdefault(session_id, {})

        # 만료 락 정리
        stale_keys = [k for k, v in session_state.items() if (v.get("expires_at", 0.0) or 0.0) <= now]
        for key in stale_keys:
            session_state.pop(key, None)

        lock = session_state.get(chat_key)
        owner = (lock or {}).get("owner")
        expires_at = (lock or {}).get("expires_at", 0.0) or 0.0

        if is_speaking:
            # 최근 선점자 우선: 기존 락이 살아있고 소유자가 다르면 교체하지 않음.
            if owner and owner != sender and expires_at > now:
                pass
            else:
                owner = sender
                expires_at = now + max(0.05, SPEAKER_LOCK_SEC)
                session_state[chat_key] = {"owner": owner, "expires_at": expires_at}
        else:
            # 현재 소유자가 발화 종료를 보낸 경우에만 짧은 그레이스 후 락 해제
            if owner == sender:
                grace = max(0.0, SPEAKER_RELEASE_GRACE_SEC)
                if grace <= 0:
                    session_state.pop(chat_key, None)
                    owner = None
                    expires_at = 0.0
                else:
                    expires_at = now + grace
                    session_state[chat_key] = {"owner": owner, "expires_at": expires_at}

        if not session_state:
            _speaker_locks_by_session.pop(session_id, None)
        else:
            _speaker_locks_by_session[session_id] = session_state

    return owner, expires_at


async def _get_active_speaker_lock(
    *,
    session_id: str,
    chat_id,
) -> tuple[str | None, float]:
    now = time.monotonic()
    chat_key = _speaker_chat_key(chat_id)
    async with _speaker_locks_guard:
        session_state = _speaker_locks_by_session.get(session_id) or {}
        lock = session_state.get(chat_key)
        owner = (lock or {}).get("owner")
        expires_at = (lock or {}).get("expires_at", 0.0) or 0.0
        if owner and expires_at > now:
            return owner, expires_at
        return None, 0.0


# ============================================
# REST API 엔드포인트
# ============================================

@app.get("/")
async def root():
    """API 루트 - 상태 확인"""
    return {
        "status": "running",
        "service": "실시간 통역 시스템",
        "version": "1.0.0",
        "websocket_connections": len(manager.active_connections)
    }


@app.get("/health")
async def health_check():
    """헬스 체크"""
    return {
        "status": "healthy",
        "connections": len(manager.active_connections)
    }


def _qstt_app_root() -> Path:
    raw = os.environ.get("QSTT_APP_ROOT")
    if raw:
        return Path(raw).resolve()
    # PyInstaller: __file__은 _MEIPASS 아래라 프로필 경로와 불일치 → exe는 .../backend/backend.exe 가정
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent.parent
    return Path(__file__).resolve().parent.parent


def _qstt_chrome_profile_root() -> Path:
    raw = os.environ.get("QSTT_CHROME_PROFILE_ROOT")
    if raw:
        return Path(raw).resolve()
    return (_qstt_app_root() / ".chrome-profiles").resolve()


def _kill_kiosk_chrome_windows() -> dict:
    """
    런처가 연 상담자/고객 키오스크 Chrome만 종료 (.chrome-profiles/counselor|client).
    일반·시크릿 창 모두 동일 프로필 경로가 커맨드라인에 포함되면 함께 매칭됩니다.
    """
    profile_root = _qstt_chrome_profile_root()
    markers = [
        str((profile_root / "counselor").resolve()),
        str((profile_root / "client").resolve()),
    ]
    env = {**os.environ, "QSTT_CHROME_PROFILE_MARKERS": json.dumps(markers, ensure_ascii=False)}
    ps = r"""
$ErrorActionPreference = 'SilentlyContinue'
$markers = $env:QSTT_CHROME_PROFILE_MARKERS | ConvertFrom-Json
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return }
  $low = $cl.ToLowerInvariant()
  foreach ($m in $markers) {
    if ($low.Contains([string]$m.ToLowerInvariant())) {
      [void]$pids.Add($_.ProcessId)
      return
    }
  }
}
foreach ($chromePid in $pids) {
  & taskkill.exe /PID $chromePid /T /F 2>$null
}
@{ ok = $true; killed = @([int[]]@($pids)) } | ConvertTo-Json -Compress
"""
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    out = (completed.stdout or "").strip()
    if completed.returncode != 0 and not out:
        err = (completed.stderr or "").strip()
        logger.warning("close-chrome powershell rc=%s err=%s", completed.returncode, err)
        return {"ok": False, "error": err or f"exit {completed.returncode}"}
    try:
        return json.loads(out) if out else {"ok": True, "killed": []}
    except json.JSONDecodeError:
        logger.warning("close-chrome unexpected output: %s", out[:500])
        return {"ok": True, "killed": [], "raw": out}


def _schedule_kill_launcher_tree_windows(launcher_pid: int) -> None:
    """
    응답 후 Node/pkg 런처까지 내려가야 함.
    지연 taskkill을 Python의 직접 자식으로만 띄우면 /T 정리 시 같이 죽어 런처가 남는 경우가 있어,
    Start-Process로 부모와 무관한 PowerShell을 한 번 더 띄운 뒤 그 안에서 sleep+taskkill 실행.
    """
    if launcher_pid <= 0 or launcher_pid == os.getpid():
        return
    delay_sec = 2
    inner_ps = f"Start-Sleep -Seconds {delay_sec}; taskkill /PID {launcher_pid} /T /F"
    inner_b64 = base64.b64encode(inner_ps.encode("utf-16-le")).decode("ascii")
    wrapper = (
        "Start-Process -FilePath powershell.exe "
        "-ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden',"
        f"'-EncodedCommand','{inner_b64}' "
        "-WindowStyle Hidden"
    )
    try:
        subprocess.Popen(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                wrapper,
            ],
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    except OSError as e:
        logger.warning("schedule launcher kill failed: %s", e)


def _kiosk_shutdown_stack_windows() -> dict:
    """Chrome 종료 후, 런처가 넘긴 QSTT_LAUNCHER_PID가 있으면 Node/pkg 프로세스 트리도 종료 예약."""
    chrome = _kill_kiosk_chrome_windows()
    out: dict = {**chrome, "launcher_scheduled": False}
    raw = (os.environ.get("QSTT_LAUNCHER_PID") or "").strip()
    if not raw:
        out["launcher_skip"] = "no_env"
        return out
    try:
        launcher_pid = int(raw)
    except ValueError:
        out["launcher_skip"] = "invalid_env"
        return out
    if launcher_pid == os.getpid():
        out["launcher_skip"] = "same_as_backend"
        return out
    _schedule_kill_launcher_tree_windows(launcher_pid)
    out["launcher_scheduled"] = True
    out["launcher_pid"] = launcher_pid
    return out


def _minimize_kiosk_chrome_windows() -> dict:
    """
    런처가 연 상담자/고객 키오스크 Chrome만 작업 표시줄로 최소화.
    종료 로직과 동일하게 .chrome-profiles 경로를 기준으로 대상을 찾는다.
    """
    profile_root = _qstt_chrome_profile_root()
    markers = [
        str((profile_root / "counselor").resolve()),
        str((profile_root / "client").resolve()),
    ]
    env = {**os.environ, "QSTT_CHROME_PROFILE_MARKERS": json.dumps(markers, ensure_ascii=False)}
    ps = r"""
$ErrorActionPreference = 'SilentlyContinue'
$markers = $env:QSTT_CHROME_PROFILE_MARKERS | ConvertFrom-Json
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return }
  $low = $cl.ToLowerInvariant()
  foreach ($m in $markers) {
    if ($low.Contains([string]$m.ToLowerInvariant())) {
      [void]$pids.Add($_.ProcessId)
      return
    }
  }
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinUser {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$minimized = New-Object 'System.Collections.Generic.List[int]'
foreach ($chromePid in $pids) {
  try {
    $proc = Get-Process -Id $chromePid -ErrorAction Stop
    if ($proc.MainWindowHandle -ne 0) {
      [void][WinUser]::ShowWindow($proc.MainWindowHandle, 6)
      [void]$minimized.Add($chromePid)
    }
  } catch {}
}
@{
  ok = $true
  matched = @([int[]]@($pids))
  minimized = @([int[]]@($minimized))
} | ConvertTo-Json -Compress
"""
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    out = (completed.stdout or "").strip()
    if completed.returncode != 0 and not out:
        err = (completed.stderr or "").strip()
        logger.warning("minimize-chrome powershell rc=%s err=%s", completed.returncode, err)
        return {"ok": False, "error": err or f"exit {completed.returncode}"}
    try:
        return json.loads(out) if out else {"ok": True, "matched": [], "minimized": []}
    except json.JSONDecodeError:
        logger.warning("minimize-chrome unexpected output: %s", out[:500])
        return {"ok": True, "matched": [], "minimized": [], "raw": out}


@app.post("/api/kiosk/minimize-chrome")
async def minimize_kiosk_chrome():
    """
    키오스크 모드 Chrome 창을 작업 표시줄로 최소화 (종료 아님).
    종료 로직과 동일한 프로필 경로 기준으로 상담자/고객 창만 찾는다.
    """
    if sys.platform != "win32":
        return {"ok": True, "skipped": True}
    result = await asyncio.to_thread(_minimize_kiosk_chrome_windows)
    return JSONResponse(result)


@app.post("/api/kiosk/close-chrome")
async def close_kiosk_chrome():
    """
    EXE+키오스크 모드: 앱이 연 Chrome(상담·고객) 종료.
    Windows에서 런처가 설정한 QSTT_LAUNCHER_PID가 있으면 Node(또는 pkg exe)·정적 서버까지 지연 후 종료.
    비 Windows는 no-op.
    """
    if sys.platform != "win32":
        return {"ok": True, "skipped": True}
    result = await asyncio.to_thread(_kiosk_shutdown_stack_windows)
    return JSONResponse(result)


@app.get("/api/license-tier")
async def get_license_tier():
    """클라이언트(정적 프론트)가 라이센스 등급을 조회 — A: 언어 목록 제한, B: 전체"""
    raw = (os.getenv("QSTT_LICENSE_TIER") or "B").strip().upper()
    tier = "A" if raw == "A" else "B"
    return {"tier": tier}


@app.get("/api/languages")
async def get_supported_languages():
    """지원 언어 목록 조회"""
    return {
        "languages": [
            {"code": "ko", "name": "한국어 (Korean)"},
            {"code": "zh-CN", "name": "中文 (Chinese)"},
            {"code": "vi", "name": "Tiếng Việt (Vietnamese)"},
            {"code": "th", "name": "ไทย (Thai)"},
            {"code": "en", "name": "English (US)"},
            {"code": "uz", "name": "Oʻzbekcha (Uzbek)"},
            {"code": "tl", "name": "Filipino (Tagalog)"},
            {"code": "id", "name": "Bahasa Indonesia (Indonesian)"},
            {"code": "ja", "name": "日本語 (Japanese)"},
            {"code": "zh-HK", "name": "廣東話 (Cantonese - Hong Kong)"},
            {"code": "en-SG", "name": "English (Singapore)"},
        ]
    }


# ============================================================
# 채팅 세션 / 메시지 REST API (SQLite3)
# ============================================================

@app.get("/api/chats")
async def list_chats(session_id: str, role: str = ""):
    """세션별 공유 채팅 목록 조회 (상담원/피상담자 동일 목록). role은 무시."""
    try:
        chats = get_chats(session_id)
        return {"chats": chats}
    except Exception as e:
        logger.error(f"채팅 목록 조회 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chats")
async def create_new_chat(request: Request):
    """새 채팅방 생성 (해당 세션의 상담원/피상담자 화면에 동일 채팅방으로 추가됨)"""
    try:
        body = await request.json()
        session_id = body.get("session_id", "")
        title = body.get("title")
        domain = body.get("domain", "bank")
        if not session_id:
            raise HTTPException(status_code=400, detail="session_id가 필요합니다")
        chat_id = create_chat(
            session_id,
            title,
            customer_name=CUSTOMER_NAME,
            device_id=DEVICE_ID,
            domain=domain,
        )
        chats = get_chats(session_id)
        # 같은 세션의 모든 연결에 목록 갱신 + 새 채팅방 ID 전달 (피상담자가 해당 채팅방으로 자동 전환)
        await manager.send_message(session_id, {"type": "chat_list_updated", "session_id": session_id, "chat_id": chat_id})
        return {"chat_id": chat_id, "chats": chats}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"채팅 생성 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/chats/{chat_id}/messages")
async def list_messages(chat_id: int):
    """채팅 세션 메시지 목록 조회"""
    try:
        msgs = get_messages(chat_id)
        return {"messages": msgs}
    except Exception as e:
        logger.error(f"메시지 목록 조회 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/chats/{chat_id}/audio")
async def list_audio_segments(chat_id: int):
    """채팅 세션 음성 세그먼트 목록 조회 (GCS URI 메타데이터)."""
    try:
        segments = get_audio_segments(chat_id)
        return {"audio_segments": segments}
    except Exception as e:
        logger.error(f"음성 세그먼트 목록 조회 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chats/{chat_id}/messages")
async def save_message(chat_id: int, request: Request):
    """메시지 저장. 첫 메시지 저장 시 채팅 제목 자동 갱신"""
    try:
        body = await request.json()
        sender = body.get("sender", "")
        original_text = body.get("original_text", "")
        translated_text = body.get("translated_text")
        source_lang = body.get("source_lang")
        target_lang = body.get("target_lang")
        request_id = body.get("request_id")
        is_first = body.get("is_first", False)

        if not sender or not original_text:
            raise HTTPException(status_code=400, detail="sender와 original_text가 필요합니다")

        msg_id = add_message(chat_id, sender, request_id, original_text, translated_text, source_lang, target_lang)

        # 첫 번째 메시지인 경우 제목 자동 갱신 (원문 앞 20자)
        if is_first:
            new_title = original_text[:20].strip()
            if new_title:
                update_chat_title(chat_id, new_title)

        return {"message_id": msg_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"메시지 저장 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/chats/{chat_id}")
async def remove_chat(chat_id: int):
    """채팅방 삭제. 같은 세션의 상대편에도 목록 갱신 알림."""
    try:
        session_id = get_chat_session_id(chat_id)
        delete_chat(chat_id)
        if session_id:
            await manager.send_message(session_id, {"type": "chat_list_updated", "session_id": session_id})
        return {"ok": True}
    except Exception as e:
        logger.error(f"채팅 삭제 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/chats/{chat_id}")
async def rename_chat(chat_id: int, request: Request):
    """채팅방(세션) 제목 변경. 같은 세션의 상대편에도 목록 갱신 알림."""
    try:
        body = await request.json()
        title = (body or {}).get("title")
        if not title or not str(title).strip():
            raise HTTPException(status_code=400, detail="title이 필요합니다")
        session_id = get_chat_session_id(chat_id)
        if not session_id:
            raise HTTPException(status_code=404, detail="채팅방을 찾을 수 없습니다")
        update_chat_title(chat_id, str(title).strip())
        if session_id:
            await manager.send_message(session_id, {"type": "chat_list_updated", "session_id": session_id})
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"채팅 제목 변경 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# 도메인 용어 사전 REST API
# ============================================================

DOMAIN_META = {
    "bank": "은행",
    "hospital": "병원",
}


@app.get("/api/domains")
async def list_domains():
    """지원 도메인 목록 조회"""
    return {"domains": [{"id": k, "name": v} for k, v in DOMAIN_META.items()]}


@app.get("/api/domains/{domain}/terms")
async def list_domain_terms(domain: str):
    """도메인 용어 목록 조회"""
    if domain not in DOMAIN_META:
        raise HTTPException(status_code=404, detail=f"도메인을 찾을 수 없습니다: {domain}")
    try:
        terms = get_domain_terms(domain)
        return {"terms": terms}
    except Exception as e:
        logger.error(f"도메인 용어 조회 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/domains/{domain}/terms")
async def create_domain_term(domain: str, request: Request):
    """도메인 용어 추가"""
    if domain not in DOMAIN_META:
        raise HTTPException(status_code=404, detail=f"도메인을 찾을 수 없습니다: {domain}")
    try:
        body = await request.json()
        term = (body.get("term") or "").strip()
        if not term:
            raise HTTPException(status_code=400, detail="term이 필요합니다")
        term_id = add_domain_term(domain, term)
        return {"term_id": term_id, "term": term}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"도메인 용어 추가 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/domains/{domain}/terms/{term_id}")
async def remove_domain_term(domain: str, term_id: int):
    """도메인 용어 삭제"""
    if domain not in DOMAIN_META:
        raise HTTPException(status_code=404, detail=f"도메인을 찾을 수 없습니다: {domain}")
    try:
        delete_domain_term(term_id)
        return {"ok": True}
    except Exception as e:
        logger.error(f"도메인 용어 삭제 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/translate")
async def translate_text(request: Request):
    """
    텍스트 번역 REST API
    
    Request JSON:
    {
        "text": "번역할 텍스트",
        "source_lang": "ko",
        "target_lang": "en"
    }
    """
    try:
        data = await request.json()
        text = data.get("text", "")
        source_lang = data.get("source_lang", "ko")
        target_lang = data.get("target_lang", "en")
        
        if not text:
            return JSONResponse(
                status_code=400,
                content={"error": "텍스트가 비어있습니다"}
            )
        
        # 언어 코드 변환
        lang_map = {
            "ko": "ko-KR",
            "zh": "zh-CN",
            "zh-CN": "zh-CN",
            "zh-HK": "zh-HK",
            "vi": "vi-VN",
            "th": "th-TH",
            "en": "en-US",
            "en-SG": "en-SG",
            "uz": "uz-UZ",
            "tl": "tl-PH",
            "id": "id-ID",
            "ja": "ja-JP",
        }
        
        source_lang_full = lang_map.get(source_lang, f"{source_lang}-{source_lang.upper()}")
        target_lang_full = lang_map.get(target_lang, f"{target_lang}-{target_lang.upper()}")
        
        # 서비스 import
        from services.translator import TranslatorService
        
        # 후처리
        processed_text = text
        
        # 번역
        translator = TranslatorService()
        translated_text = await translator.translate(
            processed_text,
            source_lang_full,
            target_lang_full
        )
        
        return {
            "success": True,
            "original": text,
            "processed": processed_text,
            "translated": translated_text,
            "source_lang": source_lang,
            "target_lang": target_lang
        }
        
    except Exception as e:
        logger.error(f"번역 오류: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": f"번역 중 오류 발생: {str(e)}"}
        )


# ============================================
# WebSocket 엔드포인트
# ============================================

@app.websocket("/ws/test")
async def test_websocket(websocket: WebSocket):
    """
    간단한 WebSocket 테스트 엔드포인트
    텍스트 에코 서버
    """
    session_id = f"test-{id(websocket)}"
    
    try:
        await websocket.accept()
        logger.info(f"✅ 테스트 WebSocket 연결: {session_id}")
        
        # 환영 메시지
        await websocket.send_text("WebSocket 연결 성공!")
        
        while True:
            # 메시지 수신
            message = await websocket.receive_text()
            logger.info(f"📨 수신 [{session_id}]: {message}")
            
            # 에코 응답
            response = f"Echo: {message}"
            await websocket.send_text(response)
            logger.info(f"📤 전송 [{session_id}]: {response}")
            
    except WebSocketDisconnect:
        logger.info(f"❌ 테스트 WebSocket 연결 종료: {session_id}")
    except Exception as e:
        logger.error(f"❌ 테스트 WebSocket 오류 [{session_id}]: {e}", exc_info=True)


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """
    실시간 통역을 위한 WebSocket 엔드포인트
    
    메시지 타입:
    1. ping/pong - 연결 유지 확인
    2. text - 텍스트 직접 번역
    """
    await manager.connect(session_id, websocket)
    
    # 서비스 초기화
    services_available = False
    audio_stream_keys: set[str] = set()
    audio_stream_pending_texts: dict[str, str] = {}
    audio_stream_pending_updated_at: dict[str, float] = {}
    # fr 등 GCP 기본 모델이 mid-stream is_final 을 발행하지 않는 언어를 위한 침묵 기반 강제 플러시
    audio_stream_interim_text: dict[str, str] = {}
    audio_stream_interim_at: dict[str, float] = {}
    audio_stream_utterance_seq: dict[str, int] = {}
    audio_stream_inflight_texts: dict[str, dict[str, str]] = {}
    audio_stream_recent_committed_texts: dict[str, list[tuple[str, float]]] = {}
    audio_stream_committed_counts: dict[str, int] = {}
    audio_stream_pcm_buffers: dict[str, bytearray] = {}
    audio_stream_started_at_ms: dict[str, int] = {}
    audio_stream_meta: dict[str, dict] = {}
    audio_stream_saved: set[str] = set()
    # Chirp 3 최종 품질을 우선하기 위해 침묵 기반 강제 플러시는 기본 비활성화.
    # 필요 시 환경변수로만 켠다. (예: 일부 언어가 mid-stream final 을 거의 내지 않을 때)
    INTERIM_SILENCE_FLUSH_ENABLED = (os.getenv("GCP_STT_INTERIM_SILENCE_FLUSH", "0").strip() == "1")
    INTERIM_SILENCE_FLUSH_SEC = 2.4
    # 동일 발화의 연속 중복 final 이벤트만 제거하고,
    # 사용자가 같은 문장을 다시 말한 경우는 살리기 위한 짧은 dedupe 윈도우
    STT_FINAL_DEDUPE_WINDOW_SEC = float((os.getenv("QSTT_STT_FINAL_DEDUPE_WINDOW_SEC") or "1.2").strip() or "1.2")
    ENABLE_PSEUDO_INTERIM = (os.getenv("QSTT_ENABLE_PSEUDO_INTERIM", "0").strip() == "1")
    stt_service = None
    translator_service = None
    tts_service = None
    audio_storage = None
    current_domain: str = "bank"
    interim_probe_started_at: float | None = None
    interim_probe_until: float = 0.0
    interim_probe_logged: bool = False
    interim_probe_stats: dict[str, dict[str, int]] = {}
    missing_chat_id_warned_keys: set[str] = set()

    def warn_missing_chat_id(
        message_type: str,
        sender_value: str = "",
        request_id_value=None,
    ) -> None:
        request_key = request_id_value if request_id_value is not None else "-"
        dedupe_key = f"{message_type}:{sender_value or 'unknown'}:{request_key}"
        if dedupe_key in missing_chat_id_warned_keys:
            return
        missing_chat_id_warned_keys.add(dedupe_key)
        logger.warning(
            "[room-scope] chat_id 누락 [%s] session=%s sender=%s request_id=%s",
            message_type,
            session_id,
            sender_value or "unknown",
            request_key,
        )

    async def persist_audio_segment(stream_key: str) -> None:
        if stream_key in audio_stream_saved:
            return
        if not audio_storage or not getattr(audio_storage, "enabled", False):
            return

        meta = audio_stream_meta.get(stream_key) or {}
        chat_id = meta.get("chat_id")
        sender_value = meta.get("sender", "counselor")
        request_id_value = meta.get("request_id")
        sample_rate_value = int(meta.get("sample_rate_hz") or 16000)
        pcm_buffer = audio_stream_pcm_buffers.get(stream_key)
        if chat_id is None or not pcm_buffer:
            return

        pcm_bytes = bytes(pcm_buffer)
        if not pcm_bytes:
            return

        try:
            gcs_uri = await asyncio.to_thread(
                audio_storage.upload_pcm_as_wav,
                customer_name=CUSTOMER_NAME,
                device_id=DEVICE_ID,
                session_id=session_id,
                chat_id=int(chat_id),
                sender=sender_value,
                request_id=request_id_value,
                sample_rate_hz=sample_rate_value,
                pcm_bytes=pcm_bytes,
            )
            if not gcs_uri:
                return

            started_at_ms = audio_stream_started_at_ms.get(stream_key)
            ended_at_ms = int(time.time() * 1000)
            duration_ms = int(len(pcm_bytes) / max(1, sample_rate_value * 2) * 1000)
            await asyncio.to_thread(
                add_audio_segment,
                int(chat_id),
                sender_value,
                request_id_value,
                "audio/wav",
                sample_rate_value,
                gcs_uri,
                len(pcm_bytes),
                duration_ms,
                started_at_ms,
                ended_at_ms,
            )
            audio_stream_saved.add(stream_key)
            logger.info("[AudioStorage] 업로드 완료 [%s]: %s", stream_key, gcs_uri)
        except Exception as storage_error:
            logger.warning("[AudioStorage] 업로드 실패 [%s]: %s", stream_key, storage_error, exc_info=True)

    def start_interim_probe_if_needed() -> None:
        nonlocal interim_probe_started_at, interim_probe_until, interim_probe_logged
        if interim_probe_started_at is not None:
            return
        started_at = time.monotonic()
        interim_probe_started_at = started_at
        interim_probe_until = started_at + 60.0
        interim_probe_logged = False
        logger.info("[STT interim probe] 시작: sender별 interim 이벤트를 60초간 수집합니다. [%s]", session_id)

    def record_interim_probe(sender_value: str, text_value: str, is_final_value: bool) -> None:
        if interim_probe_started_at is None or interim_probe_logged:
            return
        sender_key = sender_value or "unknown"
        stats = interim_probe_stats.setdefault(sender_key, {
            "interim_events": 0,
            "interim_nonempty_events": 0,
            "interim_chars_total": 0,
            "interim_last_len": 0,
            "final_events": 0,
            "browser_interim_events": 0,
            "browser_interim_nonempty_events": 0,
            "browser_interim_chars_total": 0,
            "browser_interim_last_len": 0,
            "interim_source_browser_stt_events": 0,
            "interim_source_gcp_transcription_events": 0,
            "interim_source_clear_events": 0,
        })
        if is_final_value:
            stats["final_events"] += 1
            return
        stats["interim_events"] += 1
        trimmed = (text_value or "").strip()
        text_len = len(trimmed)
        stats["interim_last_len"] = text_len
        stats["interim_chars_total"] += text_len
        if text_len > 0:
            stats["interim_nonempty_events"] += 1

    def record_browser_interim_probe(sender_value: str, text_value: str, source_value: str = "unknown") -> None:
        if interim_probe_started_at is None or interim_probe_logged:
            return
        sender_key = sender_value or "unknown"
        stats = interim_probe_stats.setdefault(sender_key, {
            "interim_events": 0,
            "interim_nonempty_events": 0,
            "interim_chars_total": 0,
            "interim_last_len": 0,
            "final_events": 0,
            "browser_interim_events": 0,
            "browser_interim_nonempty_events": 0,
            "browser_interim_chars_total": 0,
            "browser_interim_last_len": 0,
            "interim_source_browser_stt_events": 0,
            "interim_source_gcp_transcription_events": 0,
            "interim_source_clear_events": 0,
        })
        stats["browser_interim_events"] += 1
        source_key = (source_value or "unknown").strip()
        if source_key == "browser_stt":
            stats["interim_source_browser_stt_events"] += 1
        elif source_key == "gcp_transcription":
            stats["interim_source_gcp_transcription_events"] += 1
        elif source_key == "clear":
            stats["interim_source_clear_events"] += 1
        trimmed = (text_value or "").strip()
        text_len = len(trimmed)
        stats["browser_interim_last_len"] = text_len
        stats["browser_interim_chars_total"] += text_len
        if text_len > 0:
            stats["browser_interim_nonempty_events"] += 1

    def flush_interim_probe_if_due(force: bool = False) -> None:
        nonlocal interim_probe_logged
        if interim_probe_started_at is None or interim_probe_logged:
            return
        now = time.monotonic()
        if not force and now < interim_probe_until:
            return
        elapsed = now - interim_probe_started_at
        if not interim_probe_stats:
            logger.info("[STT interim probe] 결과(%0.1fs): 수집된 interim 이벤트가 없습니다. [%s]", elapsed, session_id)
            interim_probe_logged = True
            return
        for sender_key, stats in interim_probe_stats.items():
            logger.info(
                "[STT interim probe] 결과(%0.1fs) sender=%s "
                "gcp_interim_events=%d nonempty=%d chars_total=%d last_len=%d final_events=%d "
                "interim_text_events=%d nonempty=%d chars_total=%d last_len=%d "
                "src(browser_stt=%d,gcp_transcription=%d,clear=%d) [%s]",
                elapsed,
                sender_key,
                stats.get("interim_events", 0),
                stats.get("interim_nonempty_events", 0),
                stats.get("interim_chars_total", 0),
                stats.get("interim_last_len", 0),
                stats.get("final_events", 0),
                stats.get("browser_interim_events", 0),
                stats.get("browser_interim_nonempty_events", 0),
                stats.get("browser_interim_chars_total", 0),
                stats.get("browser_interim_last_len", 0),
                stats.get("interim_source_browser_stt_events", 0),
                stats.get("interim_source_gcp_transcription_events", 0),
                stats.get("interim_source_clear_events", 0),
                session_id,
            )
        interim_probe_logged = True

    async def send_tts_audio_message(
        translated_text: str,
        target_lang: str,
        sender: str,
        source_lang: str | None = None,
        request_id=None,
        chat_id=None,
    ) -> None:
        if not tts_service or not translated_text:
            return
        try:
            tts_audio_base64 = await tts_service.synthesize(
                translated_text,
                language_code=target_lang,
            )
            if not tts_audio_base64:
                return
            payload = {
                "type": "tts_audio",
                "tts_audio_base64": tts_audio_base64,
                "tts_mime_type": "audio/mpeg",
                "sender": sender,
                "target_lang": target_lang,
            }
            if source_lang is not None:
                payload["source_lang"] = source_lang
            if request_id is not None:
                payload["request_id"] = request_id
            if chat_id is not None:
                payload["chat_id"] = chat_id
            await manager.send_message(session_id, payload)
        except Exception as tts_err:
            logger.warning(f"TTS 생성 실패 [{session_id}]: {tts_err}")
    
    try:
        # 번역 서비스(필수): GOOGLE_API_KEY만 있으면 텍스트 채팅/번역 가능
        from services.translator import TranslatorService
        translator_service = TranslatorService()
        services_available = True
        logger.info(f"✅ 번역 서비스 초기화 완료 [{session_id}]")
    except Exception as e:
        logger.error(f"❌ 번역 서비스 초기화 실패 [{session_id}]: {e}", exc_info=True)
        await manager.send_message(session_id, {
            "type": "error",
            "message": f"서비스 초기화 실패: {str(e)}. GOOGLE_API_KEY를 확인하세요."
        })
        translator_service = None

    # STT/TTS(선택): credentials.json 또는 GOOGLE_APPLICATION_CREDENTIALS 필요. 없으면 음성 기능만 비활성화
    if services_available:
        try:
            from services.stt import STTService
            stt_service = STTService()
            logger.info(f"✅ STT 서비스 초기화 완료 [{session_id}]")
        except Exception as e:
            logger.warning(f"⚠️ STT 초기화 건너뜀 (음성 인식 비활성화) [{session_id}]: {e}")
            stt_service = None
        try:
            from services.tts import TTSService
            tts_service = TTSService()
            logger.info(f"✅ TTS 서비스 초기화 완료 [{session_id}]")
        except Exception as e:
            logger.warning(f"⚠️ TTS 초기화 건너뜀 (음성 합성 비활성화) [{session_id}]: {e}")
            tts_service = None
        try:
            from services.storage import GCSAudioStorage
            audio_storage = GCSAudioStorage()
        except Exception as e:
            logger.warning(f"⚠️ GCS 오디오 저장 비활성화 [{session_id}]: {e}")
            audio_storage = None

    if services_available:
        await manager.send_message(session_id, {
            "type": "connected",
            "message": "WebSocket 연결 성공",
            "session_id": session_id
        })
    
    try:
        # 메시지 수신 루프
        while True:
            # JSON 메시지 수신
            data = await websocket.receive_json()
            message_type = data.get("type", "unknown")
            
            logger.debug(f"📨 메시지 수신 [{session_id}]: {message_type}")
            
            # ===== PING/PONG - 연결 유지 =====
            if message_type == "ping":
                await websocket.send_json({
                    "type": "pong",
                    "seq": data.get("seq"),
                    "client_id": data.get("client_id"),
                    "sent_at_ms": data.get("sent_at_ms"),
                    "server_ts_ms": int(time.time() * 1000),
                })
            
            # ===== 음성 스트리밍 (STT 없으면 안내) =====
            elif message_type == "audio_stream" and services_available and not stt_service:
                await manager.send_message(session_id, {
                    "type": "error",
                    "message": "음성 인식이 비활성화되어 있습니다. credentials.json(Google Cloud 서비스 계정 키)을 설정하면 사용할 수 있습니다."
                })
            elif message_type == "audio_stream" and services_available and stt_service:
                try:
                    chunk_b64 = data.get("chunk", "")
                    is_final = bool(data.get("is_final", False))
                    audio_mime_type = data.get("mime_type", "audio/pcm")
                    sample_rate_hz = int(data.get("sample_rate_hz", 16000) or 16000)
                    source_lang = data.get("source_lang", "ko-KR")
                    target_lang = data.get("target_lang", "en-US")
                    request_id = data.get("request_id")
                    sender = data.get("sender", "counselor")
                    chat_id = data.get("chat_id")
                    if chat_id is None:
                        warn_missing_chat_id("audio_stream", sender, request_id)
                    # 서버에서도 발화권 락을 강제 적용해 비소유자 업링크를 차단한다.
                    # (프론트 누음/타이밍 레이스로 양쪽 동시 업링크되는 경우 방어)
                    active_lock_owner, active_lock_expires_at = await _get_active_speaker_lock(
                        session_id=session_id,
                        chat_id=chat_id,
                    )
                    if (
                        active_lock_owner
                        and active_lock_owner != sender
                        and active_lock_expires_at > time.monotonic()
                    ):
                        continue
                    start_interim_probe_if_needed()
                    flush_interim_probe_if_due(force=False)

                    stream_key = f"{sender}:{request_id or 'default'}"
                    audio_stream_meta[stream_key] = {
                        "chat_id": chat_id,
                        "sender": sender,
                        "request_id": request_id,
                        "sample_rate_hz": sample_rate_hz,
                    }
                    audio_stream_pending_texts.setdefault(stream_key, "")
                    audio_stream_pending_updated_at.setdefault(stream_key, 0.0)
                    audio_stream_interim_text.setdefault(stream_key, "")
                    audio_stream_interim_at.setdefault(stream_key, 0.0)
                    audio_stream_utterance_seq.setdefault(stream_key, 0)
                    audio_stream_inflight_texts.setdefault(stream_key, {})
                    audio_stream_recent_committed_texts.setdefault(stream_key, [])
                    audio_stream_committed_counts.setdefault(stream_key, 0)
                    audio_stream_pcm_buffers.setdefault(stream_key, bytearray())

                    def cleanup_stream_state() -> None:
                        audio_stream_pending_texts.pop(stream_key, None)
                        audio_stream_pending_updated_at.pop(stream_key, None)
                        audio_stream_interim_text.pop(stream_key, None)
                        audio_stream_interim_at.pop(stream_key, None)
                        audio_stream_utterance_seq.pop(stream_key, None)
                        audio_stream_inflight_texts.pop(stream_key, None)
                        audio_stream_recent_committed_texts.pop(stream_key, None)
                        audio_stream_committed_counts.pop(stream_key, None)
                        audio_stream_pcm_buffers.pop(stream_key, None)
                        audio_stream_started_at_ms.pop(stream_key, None)
                        audio_stream_meta.pop(stream_key, None)
                        audio_stream_saved.discard(stream_key)

                    def normalize_transcript(value: str) -> str:
                        return "".join(ch.lower() for ch in (value or "").strip() if ch.isalnum())

                    def next_utterance_id() -> str:
                        audio_stream_utterance_seq[stream_key] = audio_stream_utterance_seq.get(stream_key, 0) + 1
                        return f"{stream_key}:{audio_stream_utterance_seq[stream_key]}"

                    def remember_committed_text(text_value: str) -> None:
                        normalized = normalize_transcript(text_value)
                        if not normalized:
                            return
                        audio_stream_committed_counts[stream_key] = audio_stream_committed_counts.get(stream_key, 0) + 1
                        committed = audio_stream_recent_committed_texts.setdefault(stream_key, [])
                        now_mono = time.monotonic()
                        committed.append((normalized, now_mono))
                        # dedupe 윈도우 밖 기록은 정리
                        cutoff = now_mono - max(0.1, STT_FINAL_DEDUPE_WINDOW_SEC)
                        committed[:] = [(text_norm, ts) for text_norm, ts in committed if ts >= cutoff]
                        if len(committed) > 6:
                            del committed[:-6]

                    def is_duplicate_candidate(text_value: str) -> bool:
                        normalized = normalize_transcript(text_value)
                        if not normalized:
                            return True
                        candidates = list(audio_stream_inflight_texts.get(stream_key, {}).values())
                        now_mono = time.monotonic()
                        cutoff = now_mono - max(0.1, STT_FINAL_DEDUPE_WINDOW_SEC)
                        recent = audio_stream_recent_committed_texts.get(stream_key, [])
                        recent = [(text_norm, ts) for text_norm, ts in recent if ts >= cutoff]
                        audio_stream_recent_committed_texts[stream_key] = recent
                        candidates.extend(text_norm for text_norm, _ in recent)
                        for existing in candidates:
                            if not existing:
                                continue
                            if normalized == existing:
                                return True
                            if len(normalized) >= 8 and len(existing) >= 8:
                                if SequenceMatcher(None, normalized, existing).ratio() >= 0.92:
                                    return True
                        return False

                    def merge_text_with_overlap(previous_text: str, next_text: str) -> str:
                        previous_text = (previous_text or "").strip()
                        next_text = (next_text or "").strip()
                        if not previous_text:
                            return next_text
                        if not next_text:
                            return previous_text

                        previous_normalized = normalize_transcript(previous_text)
                        next_normalized = normalize_transcript(next_text)
                        if not next_normalized:
                            return previous_text
                        if next_normalized in previous_normalized:
                            return previous_text

                        previous_tokens = previous_text.split()
                        next_tokens = next_text.split()
                        max_overlap = min(len(previous_tokens), len(next_tokens), 8)
                        for size in range(max_overlap, 0, -1):
                            previous_suffix = normalize_transcript(" ".join(previous_tokens[-size:]))
                            next_prefix = normalize_transcript(" ".join(next_tokens[:size]))
                            if previous_suffix and previous_suffix == next_prefix:
                                remainder = " ".join(next_tokens[size:]).strip()
                                return f"{previous_text} {remainder}".strip() if remainder else previous_text
                        return f"{previous_text} {next_text}".strip()

                    async def send_transcription_event(
                        text_value: str,
                        *,
                        phase_value: str,
                        is_final_value: bool,
                        utterance_id: str | None = None,
                    ) -> None:
                        payload = {
                            "type": "transcription",
                            "text": text_value,
                            "is_final": is_final_value,
                            "phase": phase_value,
                            "source_lang": source_lang,
                            "sender": sender,
                            "request_id": request_id,
                        }
                        if chat_id is not None:
                            payload["chat_id"] = chat_id
                        if utterance_id is not None:
                            payload["utterance_id"] = utterance_id
                        await manager.send_message(session_id, payload)


                    async def send_stream_translation(original_text_value: str, utterance_id: str) -> None:
                        processed_text_value = original_text_value
                        normalized = normalize_transcript(original_text_value)
                        audio_stream_inflight_texts.setdefault(stream_key, {})[utterance_id] = normalized
                        try:
                            translated_text_value = await translator_service.translate(
                                processed_text_value, source_lang, target_lang, domain=current_domain
                            )
                            if translated_text_value is None:
                                translated_text_value = processed_text_value or original_text_value

                            response_value = {
                                "type": "translation_complete",
                                "message_id": str(uuid.uuid4()),
                                "utterance_id": utterance_id,
                                "original": original_text_value,
                                "processed": processed_text_value,
                                "translated": translated_text_value,
                                "source_lang": source_lang,
                                "target_lang": target_lang,
                                "sender": sender,
                            }
                            if request_id is not None:
                                response_value["request_id"] = request_id
                            if chat_id is not None:
                                response_value["chat_id"] = chat_id
                            if tts_service and translated_text_value and sender == "counselor":
                                response_value["tts_pending"] = True

                            await manager.send_message(session_id, response_value)
                            remember_committed_text(original_text_value)
                            if tts_service and translated_text_value and sender == "counselor":
                                asyncio.create_task(
                                    send_tts_audio_message(
                                        translated_text=translated_text_value,
                                        target_lang=target_lang,
                                        sender=sender,
                                        source_lang=source_lang,
                                        request_id=request_id,
                                        chat_id=chat_id,
                                    )
                                )
                        except Exception as translation_error:
                            logger.error(
                                "스트리밍 번역 처리 오류 [%s] utterance=%s: %s",
                                session_id,
                                utterance_id,
                                translation_error,
                                exc_info=True,
                            )
                            await manager.send_message(session_id, {
                                "type": "error",
                                "message": f"스트리밍 번역 실패: {str(translation_error)}"
                            })
                        finally:
                            audio_stream_inflight_texts.setdefault(stream_key, {}).pop(utterance_id, None)

                    async def finalize_candidate(text_value: str, reason: str) -> bool:
                        candidate = (text_value or "").strip()
                        if not candidate:
                            return False
                        if is_duplicate_candidate(candidate):
                            logger.info("[STT dedupe] %s reason=%s text='%s'", stream_key, reason, candidate[:80])
                            await send_transcription_event(
                                candidate,
                                phase_value="deduped",
                                is_final_value=True,
                            )
                            return False
                        utterance_id = next_utterance_id()
                        await send_transcription_event(
                            candidate,
                            phase_value="finalizing",
                            is_final_value=True,
                            utterance_id=utterance_id,
                        )
                        asyncio.create_task(send_stream_translation(candidate, utterance_id))
                        return True

                    async def buffer_final_and_maybe_flush(final_text_value: str) -> None:
                        final_text_value = (final_text_value or "").strip()
                        if not final_text_value:
                            return
                        previous = (audio_stream_pending_texts.get(stream_key) or "").strip()
                        merged = merge_text_with_overlap(previous, final_text_value)
                        audio_stream_pending_texts[stream_key] = merged
                        audio_stream_pending_updated_at[stream_key] = time.monotonic()
                        if ENABLE_PSEUDO_INTERIM:
                            await send_transcription_event(
                                merged,
                                phase_value="pseudo_interim",
                                is_final_value=False,
                            )

                    async def flush_pending_if_ready(force: bool = False) -> bool:
                        pending = (audio_stream_pending_texts.get(stream_key, "") or "").strip()
                        if not pending:
                            return False
                        if not force:
                            updated_at = audio_stream_pending_updated_at.get(stream_key, 0.0) or 0.0
                            if updated_at <= 0 or (time.monotonic() - updated_at) < 0.09:
                                return False
                        audio_stream_pending_texts[stream_key] = ""
                        audio_stream_pending_updated_at[stream_key] = 0.0
                        return await finalize_candidate(pending, "gcp_final")

                    async def flush_interim_on_silence() -> bool:
                        """fr 등 GCP 기본 모델이 mid-stream is_final 을 거의 내지 않을 때의 보조 경계 판단."""
                        interim = (audio_stream_interim_text.get(stream_key) or "").strip()
                        if not interim:
                            return False
                        if (audio_stream_pending_texts.get(stream_key) or "").strip():
                            return False
                        last_at = audio_stream_interim_at.get(stream_key, 0.0) or 0.0
                        if last_at <= 0 or (time.monotonic() - last_at) < INTERIM_SILENCE_FLUSH_SEC:
                            return False
                        audio_stream_interim_text[stream_key] = ""
                        audio_stream_interim_at[stream_key] = 0.0
                        logger.info(
                            "[STT interim 침묵 플러시] %s lang=%s text='%s'",
                            stream_key, source_lang, interim[:60],
                        )
                        return await finalize_candidate(interim, "interim_silence")

                    async def handle_stt_events(events: list) -> bool:
                        had_error = False
                        for stt_event in events:
                            if stt_event.error:
                                had_error = True
                                await manager.send_message(session_id, {
                                    "type": "error",
                                    "message": f"스트리밍 STT 실패: {stt_event.error}"
                                })
                                await send_transcription_event("", phase_value="finalizing", is_final_value=True)
                                continue

                            await send_transcription_event(
                                stt_event.text,
                                phase_value="interim",
                                is_final_value=stt_event.is_final,
                            )
                            record_interim_probe(sender, stt_event.text or "", stt_event.is_final)

                            if stt_event.is_final:
                                audio_stream_interim_text[stream_key] = ""
                                audio_stream_interim_at[stream_key] = 0.0
                                await buffer_final_and_maybe_flush(stt_event.text or "")
                            else:
                                interim_stripped = (stt_event.text or "").strip()
                                if interim_stripped:
                                    audio_stream_interim_text[stream_key] = interim_stripped
                                    audio_stream_interim_at[stream_key] = time.monotonic()
                        return had_error

                    async def rotate_stream_if_needed() -> bool:
                        if not stt_service.should_rotate_stream(stream_key):
                            return False
                        bridge_chunks = stt_service.get_stream_bridge_chunks(stream_key)
                        logger.info("[STT] 5분 제한 회피를 위해 스트림 회전 [%s]", stream_key)
                        final_events, _ = await asyncio.to_thread(stt_service.finish_stream, stream_key)
                        audio_stream_keys.discard(stream_key)
                        had_error = await handle_stt_events(final_events)
                        if had_error:
                            return True
                        stt_service.start_stream(
                            stream_key,
                            language_code=source_lang,
                            mime_type=audio_mime_type,
                            sample_rate_hz=sample_rate_hz,
                            bridge_chunks=bridge_chunks,
                        )
                        audio_stream_keys.add(stream_key)
                        return False

                    stt_service.start_stream(
                        stream_key,
                        language_code=source_lang,
                        mime_type=audio_mime_type,
                        sample_rate_hz=sample_rate_hz,
                    )
                    audio_stream_keys.add(stream_key)

                    if await rotate_stream_if_needed():
                        continue

                    if chunk_b64:
                        decoded_chunk = base64.b64decode(chunk_b64)
                        stt_service.push_stream_chunk(stream_key, decoded_chunk)
                        audio_stream_pcm_buffers.setdefault(stream_key, bytearray()).extend(decoded_chunk)
                        audio_stream_started_at_ms.setdefault(stream_key, int(time.time() * 1000))

                    had_error = await handle_stt_events(stt_service.drain_stream_results(stream_key))
                    if had_error:
                        continue

                    await flush_pending_if_ready(force=False)
                    flushed = await flush_interim_on_silence() if INTERIM_SILENCE_FLUSH_ENABLED else False
                    if flushed:
                        await asyncio.to_thread(stt_service.close_stream, stream_key)
                        audio_stream_keys.discard(stream_key)
                        await persist_audio_segment(stream_key)
                        audio_stream_pcm_buffers[stream_key] = bytearray()
                        audio_stream_started_at_ms.pop(stream_key, None)
                        audio_stream_saved.discard(stream_key)
                        audio_stream_pending_texts[stream_key] = ""
                        audio_stream_pending_updated_at[stream_key] = 0.0

                    if not is_final:
                        continue

                    final_events, original_text = await asyncio.to_thread(stt_service.finish_stream, stream_key)
                    audio_stream_keys.discard(stream_key)
                    for stt_event in final_events:
                        if stt_event.error:
                            await manager.send_message(session_id, {
                                "type": "error",
                                "message": f"스트리밍 STT 실패: {stt_event.error}"
                            })
                            continue
                        await send_transcription_event(
                            stt_event.text,
                            phase_value="interim",
                            is_final_value=stt_event.is_final,
                        )
                        record_interim_probe(sender, stt_event.text or "", stt_event.is_final)
                        if stt_event.is_final:
                            await buffer_final_and_maybe_flush(stt_event.text or "")

                    await persist_audio_segment(stream_key)
                    translated_any = await flush_pending_if_ready(force=True)
                    pending_text = (audio_stream_pending_texts.get(stream_key, "") or "").strip()
                    if pending_text:
                        translated_any = await finalize_candidate(pending_text, "stream_end_pending") or translated_any
                    now_mono = time.monotonic()
                    cutoff = now_mono - max(0.1, STT_FINAL_DEDUPE_WINDOW_SEC)
                    recent_committed = [
                        (text_norm, ts)
                        for text_norm, ts in audio_stream_recent_committed_texts.get(stream_key, [])
                        if ts >= cutoff
                    ]
                    audio_stream_recent_committed_texts[stream_key] = recent_committed
                    had_committed_before_finish = audio_stream_committed_counts.get(stream_key, 0) > 0
                    has_inflight_utterance = bool(audio_stream_inflight_texts.get(stream_key))
                    latest_interim_text = (audio_stream_interim_text.get(stream_key, "") or "").strip()
                    if not latest_interim_text:
                        for stt_event in reversed(final_events):
                            candidate_text = (stt_event.text or "").strip()
                            if candidate_text:
                                latest_interim_text = candidate_text
                                break
                    if translated_any:
                        cleanup_stream_state()
                        continue

                    if latest_interim_text and not had_committed_before_finish and not has_inflight_utterance:
                        await finalize_candidate(latest_interim_text, "stream_end_interim")
                        cleanup_stream_state()
                        continue

                    if not original_text:
                        cleanup_stream_state()
                        logger.debug(
                            "스트리밍 STT 종료: 인식 텍스트 없음(무음 등) [%s] sender=%s",
                            session_id,
                            sender,
                        )
                        continue

                    if had_committed_before_finish or has_inflight_utterance:
                        logger.info(
                            "[STT stream_end_fallback skip] 종료 직전 이미 처리된 발화가 있는 스트림 [%s] text='%s'",
                            stream_key,
                            original_text[:80],
                        )
                        cleanup_stream_state()
                        continue

                    await finalize_candidate(original_text, "stream_end_fallback")
                    cleanup_stream_state()

                except Exception as e:
                    logger.error(f"오디오 스트리밍 처리 오류 [{session_id}]: {e}", exc_info=True)
                    try:
                        stream_key = f"{data.get('sender', 'counselor')}:{data.get('request_id') or 'default'}"
                        await persist_audio_segment(stream_key)
                        stt_service.close_stream(stream_key)
                        audio_stream_keys.discard(stream_key)
                        cleanup_stream_state()
                    except Exception:
                        logger.warning("스트리밍 STT 세션 종료 실패 [%s]", session_id)
                    await manager.send_message(session_id, {
                        "type": "error",
                        "message": f"오디오 스트리밍 처리 실패: {str(e)}"
                    })
                finally:
                    flush_interim_probe_if_due(force=False)

            elif message_type == "audio" and services_available and not stt_service:
                await manager.send_message(session_id, {
                    "type": "error",
                    "message": "음성 인식이 비활성화되어 있습니다. credentials.json(Google Cloud 서비스 계정 키)을 설정하면 사용할 수 있습니다."
                })
            elif message_type == "audio" and services_available and stt_service:
                try:
                    audio_data = data.get("data", "")
                    audio_mime_type = data.get("mime_type", "audio/webm;codecs=opus")
                    source_lang = data.get("source_lang", "ko-KR")
                    target_lang = data.get("target_lang", "en-US")
                    request_id = data.get("request_id")
                    sender = data.get("sender", "counselor")
                    chat_id = data.get("chat_id")
                    if chat_id is None:
                        warn_missing_chat_id("audio", sender, request_id)

                    if not audio_data:
                        continue

                    original_text = await stt_service.transcribe(
                        audio_data,
                        source_lang,
                        mime_type=audio_mime_type,
                    )
                    if not original_text:
                        logger.debug(
                            "단일 오디오 STT: 인식 텍스트 없음(무음 등) [%s] sender=%s",
                            session_id,
                            sender,
                        )
                        continue

                    await manager.send_message(session_id, {
                        "type": "transcription",
                        "text": original_text,
                        "is_final": True,
                        "source_lang": source_lang,
                        "sender": sender,
                        "request_id": request_id,
                        "chat_id": chat_id,
                    })

                    processed_text = original_text
                    translated_text = await translator_service.translate(
                        processed_text, source_lang, target_lang, domain=current_domain
                    )
                    if translated_text is None:
                        translated_text = processed_text or original_text

                    response = {
                        "type": "translation_complete",
                        "message_id": str(uuid.uuid4()),
                        "original": original_text,
                        "processed": processed_text,
                        "translated": translated_text,
                        "source_lang": source_lang,
                        "target_lang": target_lang,
                        "sender": sender,
                    }
                    if request_id is not None:
                        response["request_id"] = request_id
                    if chat_id is not None:
                        response["chat_id"] = chat_id
                    # 상담사 발화만 TTS 생성
                    if tts_service and translated_text and sender == "counselor":
                        response["tts_pending"] = True

                    await manager.send_message(session_id, response)
                    if tts_service and translated_text and sender == "counselor":
                        asyncio.create_task(
                            send_tts_audio_message(
                                translated_text=translated_text,
                                target_lang=target_lang,
                                sender=sender,
                                source_lang=source_lang,
                                request_id=request_id,
                                chat_id=chat_id,
                            )
                        )

                except Exception as e:
                    logger.error(f"Audio processing error [{session_id}]: {e}", exc_info=True)
                    await manager.send_message(session_id, {
                        "type": "error",
                        "message": f"Audio processing failed: {str(e)}"
                    })

            elif message_type == "text" and services_available:
                try:
                    start_time = time.time()
                    
                    text = data.get("text", "")
                    source_lang = data.get("source_lang", "ko-KR")
                    target_lang = data.get("target_lang", "en-US")
                    request_id = data.get("request_id")  # 최신 우선 전략용
                    sender = data.get("sender", "counselor")  # 'counselor' or 'client'
                    chat_id = data.get("chat_id")  # 메시지가 속한 채팅방 (중복/잘못된 방 표시 방지)
                    if chat_id is None:
                        warn_missing_chat_id("text", sender, request_id)
                    
                    logger.info(f"📥 텍스트 번역 요청 수신 #{request_id} [{session_id}] from {sender} chat_id={chat_id}: {text[:50]}... (source={source_lang}, target={target_lang})")
                    
                    if not text:
                        logger.warning(f"⚠️ 빈 텍스트 수신 [{session_id}]")
                        continue
                    
                    # 후처리
                    t1 = time.time()
                    processed_text = text
                    t2 = time.time()
                    logger.info(f"⏱️ 후처리 시간: {(t2-t1)*1000:.0f}ms")
                    
                    # 번역만 수행 (TTS는 프론트엔드에서 처리)
                    t3 = time.time()
                    translated_text = await translator_service.translate(
                        processed_text, source_lang, target_lang, domain=current_domain
                    )
                    t4 = time.time()
                    logger.info(f"⏱️ Gemini 번역 API 시간: {(t4-t3)*1000:.0f}ms")
                    
                    # 번역 실패 시 원문으로 폴백 (상담자 화면에 메시지가 반드시 전달되도록)
                    if translated_text is None:
                        logger.warning(f"⚠️ 번역 API가 None 반환 [{session_id}], 원문으로 폴백")
                        translated_text = processed_text or text
                    
                    # TTS 없이 번역 결과만 즉시 전송 (request_id, sender, chat_id 포함)
                    response = {
                        "type": "translation_complete",
                        "message_id": str(uuid.uuid4()),
                        "original": text,
                        "processed": processed_text,
                        "translated": translated_text,
                        "source_lang": source_lang,
                        "target_lang": target_lang,
                        "sender": sender
                    }
                    if request_id is not None:
                        response["request_id"] = request_id
                    if chat_id is not None:
                        response["chat_id"] = chat_id
                    # 상담사 발화만 TTS 생성
                    if tts_service and translated_text and sender == "counselor":
                        response["tts_pending"] = True
                    
                    t5 = time.time()
                    await manager.send_message(session_id, response)
                    if tts_service and translated_text and sender == "counselor":
                        asyncio.create_task(
                            send_tts_audio_message(
                                translated_text=translated_text,
                                target_lang=target_lang,
                                sender=sender,
                                source_lang=source_lang,
                                request_id=request_id,
                                chat_id=chat_id,
                            )
                        )
                    t6 = time.time()
                    
                    total_time = (t6 - start_time) * 1000
                    safe_orig = (text or "")[:30]
                    safe_trans = (translated_text or "")[:30]
                    logger.info(f"⏱️ WebSocket 전송 시간: {(t6-t5)*1000:.0f}ms")
                    logger.info(f"✅ 텍스트 번역 완료 #{request_id} 총 시간: {total_time:.0f}ms | {safe_orig}... → {safe_trans}...")
                
                except Exception as e:
                    logger.error(f"텍스트 처리 오류 [{session_id}]: {e}", exc_info=True)
                    await manager.send_message(session_id, {
                        "type": "error",
                        "message": f"텍스트 처리 중 오류: {str(e)}"
                    })
            
            # ===== 도메인 설정 (STT 용어 사전 + 번역 프롬프트 갱신) =====
            elif message_type == "set_domain":
                try:
                    domain = data.get("domain", "bank")
                    current_domain = domain
                    if stt_service:
                        terms = get_domain_terms(domain)
                        stt_service.set_domain_terms([t["term"] for t in terms])
                    logger.info(f"🏷️ 도메인 변경 [{session_id}]: {domain}")
                except Exception as e:
                    logger.error(f"set_domain 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 언어 선택 알림 =====
            elif message_type == "language_selected":
                try:
                    role = data.get("role")  # 'counselor' or 'client'
                    language = data.get("language")  # 선택한 언어 코드
                    
                    logger.info(f"🌐 언어 선택 알림 [{session_id}]: {role} → {language}")
                    
                    # 같은 세션의 다른 클라이언트에게 브로드캐스트
                    await manager.send_message(session_id, {
                        "type": "language_selected",
                        "role": role,
                        "language": language
                    })
                
                except Exception as e:
                    logger.error(f"언어 선택 처리 오류 [{session_id}]: {e}", exc_info=True)
            
            # ===== interim 텍스트 실시간 브로드캐스트 =====
            elif message_type == "interim_text":
                try:
                    text = data.get("text", "")
                    source = data.get("source", "unknown")
                    sender = data.get("sender", "counselor")  # 'counselor' or 'client'
                    chat_id = data.get("chat_id")
                    if chat_id is None:
                        warn_missing_chat_id("interim_text", sender)
                    start_interim_probe_if_needed()
                    record_browser_interim_probe(sender, text, str(source))
                    flush_interim_probe_if_due(force=False)
                    
                    # 같은 세션의 다른 클라이언트에게 브로드캐스트
                    await manager.send_message(session_id, {
                        "type": "interim_text",
                        "text": text,
                        "source": source,
                        "sender": sender,
                        "chat_id": chat_id,
                    })
                
                except Exception as e:
                    logger.error(f"interim 텍스트 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 고객 장치 목록 업로드 =====
            elif message_type == "device_inventory":
                try:
                    devices = data.get("devices", []) or []
                    captured_at_ms = data.get("captured_at_ms")
                    logger.info(
                        "🎛️ 고객 장치 목록 수신 [%s]: count=%d captured_at_ms=%s",
                        session_id,
                        len(devices) if isinstance(devices, list) else 0,
                        captured_at_ms,
                    )
                    await manager.send_message(session_id, {
                        "type": "device_inventory",
                        "devices": devices if isinstance(devices, list) else [],
                        "captured_at_ms": captured_at_ms,
                    })
                except Exception as e:
                    logger.error(f"device_inventory 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 상담원 → 고객 장치 목록 재전송 요청 =====
            elif message_type == "device_inventory_request":
                try:
                    logger.info("🔁 고객 장치 목록 재요청 [%s]", session_id)
                    await manager.send_message(session_id, {
                        "type": "device_inventory_request",
                        "requested_at_ms": int(time.time() * 1000),
                    })
                except Exception as e:
                    logger.error(f"device_inventory_request 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 상담원 → 고객 마이크 적용 요청 =====
            elif message_type == "mic_assignment_request":
                try:
                    device_id = data.get("device_id", "")
                    device_label = data.get("device_label", "")
                    display_label = data.get("display_label", "")
                    logger.info(
                        "🎤 마이크 배정 요청 [%s]: label=%r display=%r id=%r",
                        session_id,
                        device_label,
                        display_label,
                        device_id,
                    )
                    await manager.send_message(session_id, {
                        "type": "mic_assignment_request",
                        "device_id": device_id,
                        "device_label": device_label,
                        "display_label": display_label,
                    })
                except Exception as e:
                    logger.error(f"mic_assignment_request 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 고객 → 상담원 마이크 적용 결과 =====
            elif message_type == "mic_assignment_ack":
                try:
                    payload = {
                        "type": "mic_assignment_ack",
                        "success": bool(data.get("success", False)),
                        "requested_device_id": data.get("requested_device_id", ""),
                        "requested_device_label": data.get("requested_device_label", ""),
                        "final_device_id": data.get("final_device_id", ""),
                        "final_device_label": data.get("final_device_label", ""),
                        "final_display_label": data.get("final_display_label", ""),
                        "reason": data.get("reason", ""),
                    }
                    logger.info(
                        "✅ 마이크 배정 응답 [%s]: success=%s requested=%r final=%r reason=%r",
                        session_id,
                        payload["success"],
                        payload["requested_device_id"],
                        payload["final_device_id"],
                        payload["reason"],
                    )
                    await manager.send_message(session_id, payload)
                except Exception as e:
                    logger.error(f"mic_assignment_ack 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 상담원 → 고객 원격 마이크 테스트 요청 =====
            elif message_type == "mic_test_request":
                try:
                    device_id = data.get("device_id", "")
                    device_label = data.get("device_label", "")
                    display_label = data.get("display_label", "")
                    logger.info(
                        "🧪 마이크 테스트 요청 [%s]: label=%r display=%r id=%r",
                        session_id,
                        device_label,
                        display_label,
                        device_id,
                    )
                    await manager.send_message(session_id, {
                        "type": "mic_test_request",
                        "device_id": device_id,
                        "device_label": device_label,
                        "display_label": display_label,
                    })
                except Exception as e:
                    logger.error(f"mic_test_request 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 고객 → 상담원 원격 마이크 테스트 결과 =====
            elif message_type == "mic_test_ack":
                try:
                    payload = {
                        "type": "mic_test_ack",
                        "success": bool(data.get("success", False)),
                        "requested_device_id": data.get("requested_device_id", ""),
                        "requested_device_label": data.get("requested_device_label", ""),
                        "final_device_id": data.get("final_device_id", ""),
                        "final_device_label": data.get("final_device_label", ""),
                        "final_display_label": data.get("final_display_label", ""),
                        "peak_rms": data.get("peak_rms"),
                        "reason": data.get("reason", ""),
                    }
                    logger.info(
                        "🧪 마이크 테스트 응답 [%s]: success=%s requested=%r final=%r peak=%r reason=%r",
                        session_id,
                        payload["success"],
                        payload["requested_device_id"],
                        payload["final_device_id"],
                        payload["peak_rms"],
                        payload["reason"],
                    )
                    await manager.send_message(session_id, payload)
                except Exception as e:
                    logger.error(f"mic_test_ack 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 고객 → 상담원 원격 마이크 테스트 스트림 =====
            elif message_type == "mic_test_stream":
                try:
                    payload = {
                        "type": "mic_test_stream",
                        "requested_device_id": data.get("requested_device_id", ""),
                        "requested_device_label": data.get("requested_device_label", ""),
                        "final_device_id": data.get("final_device_id", ""),
                        "final_device_label": data.get("final_device_label", ""),
                        "final_display_label": data.get("final_display_label", ""),
                        "level": data.get("level", 0),
                    }
                    await manager.send_message(session_id, payload)
                except Exception as e:
                    logger.error(f"mic_test_stream 처리 오류 [{session_id}]: {e}", exc_info=True)
            
            # ===== 상담원이 피상담자 마이크 장치를 대리 지정 =====
            elif message_type == "mic_assignment":
                try:
                    device_id    = data.get("device_id", "")
                    device_label = data.get("device_label", "")
                    logger.info(f"🎤 마이크 배정 [{session_id}]: label={device_label!r} id={device_id!r}")
                    await manager.send_message(session_id, {
                        "type": "mic_assignment",
                        "device_id": device_id,
                        "device_label": device_label,
                    })
                except Exception as e:
                    logger.error(f"mic_assignment 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 피상담자 TTS on/off (상담자가 대리 설정 or 피상담자 자신이 토글 시 동기화) =====
            elif message_type == "client_tts_set":
                try:
                    enabled = data.get("enabled", True)
                    logger.info(f"🔈 피상담자 TTS 설정 [{session_id}]: enabled={enabled}")
                    await manager.send_message(session_id, {
                        "type": "client_tts_set",
                        "enabled": enabled
                    })
                except Exception as e:
                    logger.error(f"client_tts_set 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 글자 크기 (상담자 조절 → 양쪽 동기화) =====
            elif message_type == "font_size_set":
                try:
                    font_size = data.get("font_size", 20)
                    if not isinstance(font_size, (int, float)):
                        font_size = 20
                    font_size = max(12, min(30, int(font_size)))
                    logger.info(f"📐 글자 크기 [{session_id}]: font_size={font_size}")
                    await manager.send_message(session_id, {
                        "type": "font_size_set",
                        "font_size": font_size
                    })
                except Exception as e:
                    logger.error(f"font_size_set 처리 오류 [{session_id}]: {e}", exc_info=True)
            
            # ===== 상담자 녹음 상태 → 피상담자 마이크 차단/해제 중계 =====
            elif message_type == "speaking_state":
                try:
                    sender = data.get("sender", "")
                    is_speaking = data.get("is_speaking", False)
                    speech_level = float(data.get("speech_level", 0.0) or 0.0)
                    speech_level = max(0.0, min(1.0, speech_level))
                    chat_id = data.get("chat_id")
                    if chat_id is None:
                        warn_missing_chat_id("speaking_state", sender)
                    lock_owner, lock_expires_at = await _apply_speaker_lock(
                        session_id=session_id,
                        chat_id=chat_id,
                        sender=sender,
                        is_speaking=bool(is_speaking),
                    )
                    now_mono = time.monotonic()
                    lock_remaining_ms = max(0.0, (lock_expires_at - now_mono) * 1000.0) if lock_owner else 0.0
                    lock_expires_at_ms = int(time.time() * 1000 + lock_remaining_ms) if lock_owner else None
                    logger.info(
                        "🎙️ speaking_state [%s]: sender=%s is_speaking=%s lock_owner=%s lock_remaining_ms=%d",
                        session_id,
                        sender,
                        is_speaking,
                        lock_owner,
                        int(lock_remaining_ms),
                    )
                    await manager.send_message(session_id, {
                        "type": "speaking_state",
                        "sender": sender,
                        "is_speaking": is_speaking,
                        "speech_level": speech_level,
                        "chat_id": chat_id,
                        "lock_owner": lock_owner,
                        "lock_expires_at_ms": lock_expires_at_ms,
                    })
                except Exception as e:
                    logger.error(f"speaking_state 처리 오류 [{session_id}]: {e}", exc_info=True)

            # ===== 알 수 없는 메시지 타입 =====
            else:
                logger.warning(f"⚠️ 알 수 없는 메시지 타입 [{session_id}]: {message_type}")
                if not services_available:
                    await manager.send_message(session_id, {
                        "type": "error",
                        "message": "서비스를 사용할 수 없습니다"
                    })
    
    except WebSocketDisconnect:
        logger.info(f"🔌 WebSocket 정상 종료 [{session_id}]")
        manager.disconnect(session_id, websocket)
    
    except Exception as e:
        logger.error(f"❌ WebSocket 오류 [{session_id}]: {e}", exc_info=True)
        manager.disconnect(session_id, websocket)
    finally:
        flush_interim_probe_if_due(force=True)
        if stt_service:
            for stream_key in list(audio_stream_keys):
                try:
                    await persist_audio_segment(stream_key)
                    stt_service.close_stream(stream_key)
                except Exception:
                    logger.warning("스트리밍 STT 세션 종료 실패 [%s]", stream_key)


# ============================================
# 서버 시작
# ============================================

if __name__ == "__main__":
    import uvicorn
    
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 8001))
    
    logger.info("=" * 60)
    logger.info("🚀 실시간 통역 시스템 서버 시작")
    logger.info(f"📍 주소: http://{host}:{port}")
    logger.info(f"📚 API 문서: http://{host}:{port}/docs")
    logger.info(f"🔌 WebSocket: ws://{host}:{port}/ws/{{session_id}}")
    logger.info("=" * 60)
    
    # uvicorn 실행 - WebSocket 지원 활성화
    uvicorn.run(
        app,  # 문자열 대신 app 객체 직접 전달
        host=host,
        port=port,
        log_level="info",
        access_log=True,
        timeout_keep_alive=75  # 연결 유지 시간 증가
    )
