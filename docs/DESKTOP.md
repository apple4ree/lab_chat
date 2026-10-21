# DAMI Chat 데스크톱 설치판 0.1.1

Windows x64 설치용 EXE와 macOS 13 이상 Apple Silicon·Intel용 DMG를 제공합니다. 앱은 `https://chat.damilab.cc`에 연결해 웹과 같은 계정·대화·파일·GPU 자원을 사용합니다. DB나 관리자 계정은 설치 파일에 포함하지 않습니다.

## 설치

1. `https://chat.damilab.cc/#desktop-downloads`에서 로그인하고 운영체제에 맞는 설치 파일을 받습니다. 내 계정 → 데스크톱 앱 다운로드로도 열 수 있습니다.
2. Windows에서는 EXE를 실행해 설치한 뒤 시작 메뉴의 **DAMI Chat**을 엽니다. 제거는 Windows 앱 설정에서 진행합니다. 사용자 프로필은 제거해도 기본적으로 보존됩니다.
3. Mac에서는 DMG를 열고 **DAMI Chat → Applications**로 끌어다 놓은 뒤 응용 프로그램 폴더에서 실행합니다. M 시리즈는 Apple Silicon, 이전 Intel Mac은 Intel 버전을 선택합니다.

사내 시험판입니다. Windows는 개발자 코드 서명 전이고, Mac은 무결성 검사용 ad-hoc 서명만 적용해 Apple Developer ID 서명·공증은 없습니다. 운영체제에서 경고하거나 실행을 제한할 수 있습니다. 자동 업데이트 배포 채널은 활성화하지 않았으며 새 설치 파일로 업데이트합니다. `release-config.json`의 `signedRelease=false`, `updateUrl=null`을 유지합니다.

## 앱 동작

- 앱 창, 단일 인스턴스, 트레이/메뉴바, 미읽음 배지, 알림 클릭 시 채널 이동, 외부 링크의 기본 브라우저 열기와 인증된 파일 다운로드를 제공합니다.
- 창을 닫아도 계속 실행 옵션을 켜면 연결이 이어집니다. 완전히 종료하거나 컴퓨터가 절전 상태이면 알림을 받지 않습니다. 서버 연결이 필요하며 오프라인 작성·동기화 기능은 없습니다.
- 네이티브 창이 보이고 포커스를 가진 상태에서만 읽음 처리를 수행합니다. 알림에는 메시지 본문을 넣지 않으며 기존 메시지·재연결 알림 중복을 억제합니다.

Electron은 Node 접근을 허용하지 않는 sandbox/contextIsolation 렌더러를 사용합니다. IPC의 주 프레임·출처·입력을 검사하고 내부 탐색은 현재 신뢰하는 워크스페이스로 제한합니다. 관리자에게 승인된 도메인 변경은 기존 서버와 목적지의 일치 확인을 거쳐 메인 프로세스에서 반영합니다. 서버의 인증·채널 권한 검사도 유지합니다. 참고: [Electron 보안 지침](https://www.electronjs.org/docs/latest/tutorial/security/).

## 네이티브 빌드

`.github/workflows/desktop.yml`의 **Desktop installers** 워크플로는 수동 실행 또는 `desktop-v<버전>` 태그로 실행합니다. 기본 권한은 `contents: read`이고 서버 비밀번호나 배포 SSH 키를 사용하지 않습니다. 액션은 커밋 SHA로 고정했습니다.

| 대상 | GitHub 실행 환경 | 산출물 |
|---|---|---|
| Windows x64 | windows-2025 | `DAMI-Chat-<버전>-win-x64.exe` |
| Mac Apple Silicon | macos-15 | `DAMI-Chat-<버전>-mac-arm64.dmg` |
| Mac Intel | macos-15-intel | `DAMI-Chat-<버전>-mac-x64.dmg` |

Electron 44.9.0, electron-builder 26.15.3, electron-updater 6.8.9는 `desktop/package-lock.json`으로 고정합니다. Node 버전은 루트 `.nvmrc`를 사용합니다. 버전을 올릴 때 `desktop/package.json`과 lockfile을 함께 변경합니다.

```bash
# GitHub에서 빌드
GH_CONFIG_DIR=/home/dgu/lab-chat/.data/github-auth gh workflow run desktop.yml --ref main
# Windows 로컬 빌드
cd desktop
npm ci
npm run dist:win
# Mac 로컬 빌드: 두 아키텍처 DMG
npm run dist:mac
```

ZIP 생성 명령은 개발용으로 남겨 두며 기본 다운로드에 사용하지 않습니다. Linux에서 Mac ZIP을 만들 때 `package-mac.py`가 프레임워크 링크·실행 권한을 보존합니다. [electron-builder 크로스 플랫폼 제약](https://www.electron.build/v26/docs/features/multi-platform-build/)과 [GitHub 실행 환경 목록](https://github.com/actions/runner-images)을 참고합니다.

## 검증과 게시

각 네이티브 빌드는 `desktop/test/native-package.mjs`로 실제 산출물을 검사합니다. Windows는 임시 경로에 무인 설치, 시작 메뉴 바로가기, 설치된 앱 실행, 제거를 검사합니다. Mac은 DMG 검증·읽기 전용 마운트, Applications 바로가기, 앱 복사, CPU 아키텍처·프레임워크 링크·ad-hoc 서명과 앱 실행을 검사합니다. 두 플랫폼 모두 패키지 내부 코드 일치, 격리 설정, 공개 로그인 화면을 확인합니다. 서버 로그인이나 운영 데이터 쓰기는 수행하지 않습니다.

검사가 성공한 작업만 설치 파일·스크린샷·`build-info-<platform>-<arch>.json`을 Actions 산출물로 올립니다. 보고서에는 소스 커밋, 파일 SHA-256, 크기, 수행한 검사 목록이 포함됩니다. 세 작업의 성공과 같은 소스 커밋을 확인하고 한 디렉터리로 다운로드합니다.

```bash
GH_CONFIG_DIR=/home/dgu/lab-chat/.data/github-auth gh run view RUN_ID
GH_CONFIG_DIR=/home/dgu/lab-chat/.data/github-auth gh run download RUN_ID --dir .data/installer-builds/RUN_ID
# 세 artifact 디렉터리의 설치 파일과 build-info를 하나의 검토용 디렉터리로 모은 뒤 실행
node scripts/publish-desktop.mjs .data/installer-builds/RUN_ID/verified SOURCE_COMMIT
```

게시기는 커밋의 실제 소스 해시와 보고서, 세 파일의 체크섬·형식·검사 완료 여부를 모두 확인한 후 manifest를 원자적으로 교체합니다. 같은 버전의 다른 파일로 덮어쓰기를 거부합니다. 이전 manifest와 파일은 롤백을 위해 유지합니다. `.data/desktop-releases`는 Git에 포함하지 않으며 다운로드는 로그인한 사용자에게만 허용합니다. 데모에서도 같은 파일을 제공하지만 설치 앱은 일반 워크스페이스에 연결합니다.

검증 경계: GitHub의 Windows Server/macOS 실행 환경 검증이며, 사용자의 실제 Windows 10/11·Mac에서의 수동 설치 테스트, SmartScreen/Gatekeeper 통과, 실제 OS 알림·시작 프로그램 동작·업데이트 다운로드 검증을 대체하지 않습니다. 정식 개발자 서명·Apple 공증과 자동 업데이트는 별도 작업입니다. 이번 실행의 성공 여부와 증거 경로는 DEPLOYMENT.md에 기록합니다.

이전 0.1.0의 Linux Xvfb 테스트에서는 격리 DB/프로필로 미읽음·배지, 채널 이동, GPU 화면, 로그인 유지, 로그아웃, 오프라인 화면을 검증했습니다. 해당 컨테이너 실행에만 `--no-sandbox`를 사용했으며 배포 앱은 이 플래그를 사용하지 않습니다. 이전 기록은 `.data/deploy/evidence/desktop-smoke.json`입니다.
# GitHub Release 다운로드 — 2026-10-21

[DAMI Chat v0.1.1 시험판](https://github.com/apple4ree/lab_chat/releases/tag/v0.1.1)의 Assets에 Windows x64 EXE, macOS arm64·x64 DMG와 `SHA256SUMS.txt`를 게시했습니다. `Source code (zip/tar.gz)`은 GitHub가 제공하는 소스 코드이며 설치 파일이 아닙니다. 파일 다운로드는 공개이고 앱 사용에는 연구실 로그인이 필요합니다.

태그 `v0.1.1`은 네이티브 설치 파일을 만든 커밋 `9db04b1e0804e5c2c8d55a9079f112a9c3b4d64f`을 가리킵니다. 기존 CI 검증 파일을 재사용했고 세 파일의 전체 로컬 SHA-256과 GitHub asset digest가 일치했습니다. 이 배포는 파일 게시 경로 변경이며 설치 프로그램 재빌드·정식 서명·Apple 공증·자동 업데이트 추가는 아닙니다. 웹 기능은 운영 서버의 최신 화면을 사용합니다.

운영 다운로드 manifest의 `releaseUrl`을 `https://github.com/apple4ree/lab_chat/releases/tag/v0.1.1`로 설정했습니다. 서버는 이 저장소와 manifest 버전에 정확히 일치하는 주소만 허용하고 각 다운로드 URL을 같은 태그의 asset URL로 생성합니다. UI는 외부 브라우저로 열 수 있는 링크를 제공합니다. 기존 인증된 로컬 다운로드 경로는 열린 이전 클라이언트를 위해 유지합니다. `releaseUrl`이 없으면 기존 로컬 다운로드를 사용합니다.

다음 버전은 네이티브 검증 → 빌드 커밋에 고정한 draft Release 업로드 → GitHub digest 대조 → Release 공개·익명 다운로드 검증 → manifest 연결 순서로 게시합니다. `scripts/publish-desktop.mjs`로 새 manifest를 만들면 GitHub 연결 필드는 별도로 설정해야 합니다. 검증 전에 링크를 활성화하거나 기존 태그·설치 파일을 덮어쓰지 않습니다.

공개 GitHub에서 페이지 200, 세 설치 파일의 Range 206·원본 바이트 일치, 체크섬 파일 전체 일치를 확인했습니다. 로컬 다운로드 API 회귀 3개, 브라우저 다운로드 시나리오 3개, TypeScript·Vite 빌드·용량 검사 통과. 운영·체험 배포 결과는 [DEPLOYMENT.md](DEPLOYMENT.md)에 기록합니다.

## v0.1.2 도메인 변경 지원

관리자가 대표 도메인을 바꾸면 시작 시 새 주소를 확인·저장하고, 실행 중에는 사용자 확인 후 이동합니다. 쿠키를 새 도메인에 복사하지 않습니다. 최초 주소는 `release-config.json`에, 검증된 변경 주소는 사용자 데이터 폴더의 `desktop-settings.json`에 저장합니다. URL을 환경 변수로 바꾸는 기능은 개발 실행에서만 허용합니다. [도메인 이전 절차](DOMAINS.md)를 따르세요.
