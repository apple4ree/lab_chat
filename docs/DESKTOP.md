# DAMI Chat 데스크톱 시험판 0.1.0

Windows x64, macOS 13 이상 Apple Silicon 및 Intel용 Electron 앱입니다. macOS 최소 버전은 생성한 앱의 Info.plist 기준입니다. 설치 파일에 DB나 관리자 계정을 넣지 않으며, `https://chat.damilab.cc`에 연결해 웹과 같은 계정·대화·파일·GPU 자원 화면을 사용합니다. 기존 ERP와의 연동 범위를 변경하지 않습니다.

## 사용

1. `https://chat.damilab.cc/#desktop-downloads`에서 로그인하고 운영체제에 맞는 ZIP을 받습니다. 내 계정 → 데스크톱 앱 다운로드로도 열 수 있습니다.
2. Windows에서는 ZIP 전체를 한 폴더로 풀고 `DAMI Chat.exe`를 실행합니다. macOS에서는 ZIP을 풀어 `DAMI Chat.app`을 응용 프로그램 폴더에 옮깁니다.
3. 기존 연구실 계정으로 로그인합니다. 로그인이 재시작 후 유지되며, 앱 메뉴에서 알림·백그라운드 실행·컴퓨터 로그인 시 실행을 설정할 수 있습니다.

현재 파일은 코드 서명 및 Apple 공증 전입니다. Windows/macOS 실제 설치·실행, OS 알림 팝업, 로그인 시 자동 실행은 아직 검증하지 않았습니다. OS에서 실행을 차단할 수 있으므로 연구실 전체 배포 전 실기기와 서명 검증이 필요합니다. macOS DMG와 Windows NSIS 설치 프로그램은 아래 네이티브 빌드 설정만 준비되어 있습니다. 이 Linux 서버에서 NSIS 빌드는 Wine 런타임 오류로 완료하지 못했고, 완성된 ZIP만 게시합니다.

## 동작과 경계

- 별도 앱 창, 단일 인스턴스, 트레이/메뉴바, 읽지 않은 메시지 배지, 알림 클릭 시 채널 열기, 외부 링크의 기본 브라우저 열기, 인증된 파일 다운로드를 제공합니다.
- 창을 닫아도 계속 실행 옵션을 켜면 알림 수신이 이어집니다. 앱을 완전히 종료하거나 컴퓨터가 절전 상태이면 수신하지 않습니다. 서버 연결이 필요하며 오프라인 메시지 작성·동기화 기능은 없습니다.
- 읽음 처리는 네이티브 창이 보이고 포커스를 가진 상태에서만 수행합니다. 백그라운드 Electron의 DOM visibility 값은 읽음 판정 근거로 사용하지 않습니다.
- 알림에는 메시지 본문을 넣지 않습니다. 시작할 때 기존 메시지 알림을 쏟아내지 않으며, 최신 메시지 ID로 재연결·수정에 따른 중복 알림을 억제합니다.
- 시험판 업데이트는 새 ZIP을 받아 교체합니다. 자동 업데이트 배포 채널은 활성화하지 않았습니다. `release-config.json`의 `signedRelease=false`, `updateUrl=null`을 유지합니다.

Electron 렌더러에는 Node 접근을 허용하지 않고 sandbox/contextIsolation을 켭니다. IPC는 주 프레임·출처와 입력 구조를 검사합니다. 앱 내부 탐색은 고정 워크스페이스로 제한하고 인증 정보를 포함한 URL과 임의 프로토콜 실행을 차단합니다. 공식 [Electron 보안 지침](https://www.electronjs.org/docs/latest/tutorial/security/)에 따른 구성입니다. 서버 자체의 권한 검사는 그대로 적용됩니다.

## 개발 및 패키징

Mac ZIP 생성에는 Python 3 표준 라이브러리를 사용해 프레임워크 심볼릭 링크와 실행 권한을 보존합니다. Linux의 7zip은 이 링크를 따라가므로 Mac ZIP 생성에 사용하지 않습니다.

앱 의존성은 웹 서버와 분리한 `desktop/`에 설치합니다. Electron 44.9.0, electron-builder 26.15.3, electron-updater 6.8.9와 lockfile을 고정했습니다.

```bash
cd /home/dgu/lab-chat/desktop
npm ci
npm test
npm start
```

개발 중에만 `LAB_DESKTOP_URL=http://127.0.0.1:PORT`로 로컬 서버를 사용할 수 있습니다. HTTPS 임의 서버나 패키징된 앱에는 이 우회가 적용되지 않습니다. `LAB_DESKTOP_USER_DATA`도 개발 실행에서만 별도 프로필을 지정합니다.

```bash
# Windows 또는 Linux: ZIP 배포본
npm run dist:win:zip
# macOS 또는 Linux: Intel/Apple Silicon ZIP
npm run dist:mac:zip
# Windows에서 설치 프로그램 빌드
npm run dist:win
# macOS에서 DMG 및 ZIP 빌드
npm run dist:mac
```

결과는 `desktop/release/`에 생성됩니다. 플랫폼별 서명 인증서·Apple 공증은 현재 설정하지 않았습니다. [크로스 플랫폼 빌드 제약](https://www.electron.build/v26/docs/features/multi-platform-build/)과 [코드 서명](https://www.electron.build/docs/features/code-signing/)을 확인하고 정식 배포 전에 네이티브 환경에서 빌드·검증합니다. 저장소·패키지에 인증서나 비밀번호를 넣지 않습니다.

게시할 때는 `python3 scripts/verify-desktop-packages.py`로 세 ZIP의 완성 여부·내부 코드·아키텍처·Mac 심볼릭 링크/권한을 확인한 뒤 루트에서 `node scripts/publish-desktop.mjs`를 실행합니다. SHA-256과 크기를 포함한 manifest를 `.data/desktop-releases/`에 원자적으로 게시합니다. 같은 버전의 다른 바이트로 덮어쓰는 작업은 거부하므로 변경 시 버전을 올려야 합니다. 다운로드 API는 로그인된 구성원에게만 열리며 데모에도 동일한 파일 목록을 제공합니다. 배포 앱의 접속 대상은 일반 워크스페이스입니다.

## 검증 범위

2026-10-20: 서버 테스트 33개, 데스크톱 정책 테스트 3개, 기존 브라우저 테스트 11개 및 신규 다운로드 링크 테스트 1개를 통과했습니다. TypeScript와 Vite 빌드를 통과했습니다. 실제 Electron은 Linux Xvfb에서 격리 DB/프로필로 실행했습니다. 확인 항목은 숨긴 창의 미읽음/배지 유지, 채널 이동, GPU 자원 화면, 재시작 후 세션 유지, 로그아웃 배지 초기화, 연결 실패 화면입니다. 증거는 `.data/deploy/evidence/desktop-smoke.json`입니다.

```bash
# 웹 빌드를 별도 경로에 만든 뒤 실제 Electron 검증
xvfb-run -a node desktop/test/electron-smoke.mjs /tmp/lab-chat-desktop-preview-20261020
LAB_TEST_DIST_DIR=/tmp/lab-chat-desktop-preview-20261020 npm run test:browser
```

컨테이너 테스트 실행에만 `--no-sandbox`를 사용했습니다. 배포 앱에는 이 플래그를 넣지 않습니다. 따라서 테스트가 OS 프로세스 sandbox 동작까지 입증하지 않습니다. 테스트 환경의 `Notification.isSupported()`는 false였으므로 네이티브 알림 팝업도 검증 범위에 포함하지 않습니다. Windows/macOS 실행, 인증서 서명, Apple 공증, 실제 업데이트 다운로드/설치는 별도 검증 대상입니다.
