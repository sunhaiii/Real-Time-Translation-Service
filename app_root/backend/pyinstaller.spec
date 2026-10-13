# -*- mode: python ; coding: utf-8 -*-
# 빌드: (backend 폴더에서) pyinstaller pyinstaller.spec

import os

from PyInstaller.utils.hooks import collect_data_files, copy_metadata

block_cipher = None
_spec_dir = os.path.dirname(os.path.abspath(SPEC))

datas = []
for pkg in (
    "certifi",
    "google-generativeai",
    "google-api-core",
    "google-cloud-speech",
    "google-cloud-texttospeech",
    "google-cloud-storage",
    "grpcio",
):
    try:
        datas += copy_metadata(pkg)
    except Exception:
        pass
try:
    datas += collect_data_files("certifi")
except Exception:
    pass

hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "websockets",
    "google.cloud.speech",
    "google.cloud.speech_v2",
    "google.cloud.speech_v2.types",
    "google.cloud.speech_v2.services",
    "google.cloud.speech_v2.services.speech",
    "google.cloud.texttospeech",
    "google.cloud.texttospeech_v1",
    "google.cloud.storage",
    "google.api_core",
    "google.auth",
    "google.oauth2",
    "grpc",
    "pydantic",
    "pydantic.deprecated.decorator",
    "multipart",
    "services.database",
    "services.translator",
    "services.stt",
    "services.tts",
]

a = Analysis(
    [os.path.join(_spec_dir, "main.py")],
    pathex=[_spec_dir],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
