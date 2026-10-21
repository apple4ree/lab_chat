# damilab.cc 연결 — 2026-10-19

| 서비스 | 주소 | 접근 방법 |
|---|---|---|
| 일반 계정 버전 | https://chat.damilab.cc | 최초 관리자 설정 후 계정 로그인·초대 가입 |
| 체험 버전 | https://chat-demo.damilab.cc | 브라우저 접속 인증 후 샘플 계정 선택 |

최초 설정 코드와 체험 접속 암호는 서버의 `/home/dgu/lab-chat/.data/deploy/접속정보.txt`에 저장했습니다. 파일 접근 권한은 0600입니다. 소스·Git·공개 웹 경로에 포함되지 않습니다. 브라우저 인증 창의 체험 사용자 이름은 `demo`입니다.

## 실행 구성

전용 Cloudflare Tunnel `lab-chat` (`39d597b5-39a0-4eab-a69b-8f45a8489580`)을 만들었습니다. `/home/dgu/.cloudflared/lab-chat.yml`에서 두 호스트를 127.0.0.1:4310과 127.0.0.1:4313으로 전달합니다. 두 DNS CNAME은 이 전용 터널을 가리킵니다. 기존 공유 터널 설정의 SHA-256은 변경 전후 동일합니다.

| PM2 이름 | 역할 |
|---|---|
| `lab-chat` | 일반 계정 앱, 4310 |
| `lab-chat-demo` | 접속 암호로 보호한 체험 앱, 4313 |
| `lab-chat-tunnel` | 두 호스트의 Cloudflare 연결 |

PM2가 현재 실행 중인 프로세스의 비정상 종료를 재시작합니다. 서버 재부팅 후 자동 복구는 이번에 설정·검증하지 않았습니다. 현재 PM2의 다른 앱 목록을 일괄 저장하거나 변경하지 않았습니다.

앱의 원본 허용 주소(`LAB_ORIGIN`)를 각각 HTTPS 도메인으로 설정했습니다. 쿠키는 Secure·HttpOnly·SameSite=Strict입니다. 공개 체험에서는 공유 접속 인증이 모든 경로에 먼저 적용됩니다. HTTPS 체험 모드에 접속 암호 해시가 없으면 시작을 거부합니다. 일반·체험 데이터 디렉터리는 계속 분리됩니다.

운영 설정은 `.data/deploy/local.env`, `.data/deploy/demo.env`에 있고, 프로세스 정의는 `deploy/ecosystem.config.cjs`에 있습니다. 일반 모드는 `NODE_ENV=production`, 체험 모드는 기능 시험용 `development`를 사용하며 양쪽 모두 미리 빌드한 정적 화면을 제공합니다. Vite 개발 서버는 외부에 게시하지 않았습니다.

## 관리 명령

상태 확인:

```bash
pm2 status
```

변경한 서비스만 재시작합니다. env 파일은 Node 시작 시 다시 읽습니다.

```bash
pm2 restart lab-chat
pm2 restart lab-chat-demo
pm2 restart lab-chat-tunnel
```

PM2 항목이 사라진 경우 `deploy/ecosystem.config.cjs`로 세 항목을 다시 시작할 수 있습니다. 앱과 터널의 로그 파일은 `.data/run/` 아래에 있으며 PM2가 프로세스 번호를 파일명에 붙일 수 있습니다. 최초 설정 코드가 로그에 포함될 수 있으므로 로그를 외부에 게시하지 않습니다.

DNS 등록·수정 시에는 반드시 전용 설정 파일과 터널 UUID를 함께 명시합니다. 이 환경에서 설정 파일을 생략한 명령은 기본 공유 터널을 선택했습니다. 이번에 신규 생성한 두 레코드는 즉시 전용 UUID로 교정하고 최종 목적지를 확인했습니다.

```bash
cloudflared tunnel --config /home/dgu/.cloudflared/lab-chat.yml ingress validate
cloudflared tunnel --config /home/dgu/.cloudflared/lab-chat.yml ingress rule https://chat.damilab.cc
```

## 실행한 검증

`npm test` **17/17** 통과. 추가한 검증은 HTTPS 체험의 암호 없는 시작 거부, 미인증 HTML/API/파일/이벤트 차단, 올바른 암호의 로그인, Secure 쿠키와 다른 출처 요청 거부입니다.

공개 DNS의 A 레코드를 조회하고 해당 Cloudflare 주소로 SNI·인증서 검증을 유지한 HTTPS 요청을 보냈습니다. 일반 페이지·인증 설정 API는 200, 미인증 체험은 401, 인증된 체험은 200이었습니다. 이 서버의 기본 DNS에는 초기 미등록 응답의 캐시가 남아 있어, 브라우저 검증에는 공개 DNS의 반환 주소만 브라우저 실행 옵션으로 지정했습니다. 시스템 DNS·hosts 파일은 수정하지 않았습니다.

실제 Chrome에서 일반 최초 관리자 설정 화면, 체험 접속 인증·샘플 로그인·메시지 작성창·SSE 연결을 확인했습니다. JavaScript 예외는 없었습니다. 일반 버전의 관리자 계정은 대신 생성하지 않았습니다.

검증 자료는 `.data/deploy/evidence/`에 있습니다. `public-http.json`, `public-browser.json`은 인증 토큰·비밀번호를 포함하지 않으며, 화면 캡처에는 샘플 화면만 있습니다.

설정 절차 참고: [Cloudflare 로컬 터널 생성](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/), [설정 파일과 ingress 검증](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/).

## GPU 기능 배포 — 2026-10-19 16:00 UTC

일반 서비스의 `LAB_GPU_URL=http://127.0.0.1:8800`을 추가하고 `lab-chat`, `lab-chat-demo`만 재시작했습니다. 전용 터널은 재시작하지 않았습니다. 두 앱은 스키마 2로 시작했고, 일반 서비스의 저장된 정상화 스냅샷에 실제 서버 2대·GPU 6개, 체험 서비스에는 샘플 서버 2대·GPU 4개가 있음을 확인했습니다. 양쪽 모두 공개 `gpu-자원` 채널과 시스템 알림 사용자가 생성됐습니다.

서버 테스트 24/24 통과. 기존 브라우저 시나리오 5개 통과 후 새 GPU 시나리오에서 필터의 접근성 이름을 보완했고, 수정 후 GPU 데스크톱·모바일 시나리오 2개 모두 통과했습니다. `npm run build`도 통과했습니다. 상태 전환·미사용 60초 확인·오래된 반복 샘플·재시작 중복 방지·중앙 오류·중단·복구는 격리된 테스트에서 검증했습니다. 운영 GPU를 강제로 변경해 알림을 발생시키지는 않았습니다.

공개 도메인에서 일반 HTML 200, 무로그인 GPU API 401, 무인증 체험 API 401을 확인했습니다. 체험 사이트는 실제 Chrome으로 접속 인증·샘플 로그인·GPU 4개 표시·알림 채널 이동까지 확인했고 JavaScript 예외는 없었습니다. 일반 서비스의 사용자를 대신 로그인하지는 않았으며, 일반 서비스 검증은 공개 인증 차단·실제 소스 연결 및 저장 스냅샷 확인까지입니다.

검증 기록: `.data/deploy/evidence/gpu-public.json`, `gpu-public-demo.png`. 백업: `.data/gpu-change-backup/`. 운영 계정·메시지·파일을 유지한 상태로 적용했습니다.

## 로컬 관리자 아이디 추가 — 2026-10-19

요청된 `damilab` 로컬 관리자 계정을 기존 계정과 별도로 생성했습니다. 로그인 화면은 ‘이메일 또는 아이디’를 받으며 기존 이메일 로그인과 초대 가입을 유지합니다. 비밀번호는 scrypt 해시만 저장하며 문서·설정 파일에 기록하지 않습니다. 원래 관리자 계정과 데이터는 보존했습니다. 일반 앱만 재시작했고 체험 계정은 추가하지 않았습니다.

스키마 3은 `user_login_names` 테이블을 추가합니다. 백업은 `.data/admin-login-backup/`에 있습니다. 서버 테스트 25개와 기존 이메일 가입·로그인·비밀번호 변경 브라우저 시나리오가 통과했습니다. 브라우저의 임시 빌드를 숨김 경로 밖에 두어 정적 파일 차단 문제를 해결한 뒤 재검증했습니다. 실제 관리자 로그인 검증 결과는 `.data/deploy/evidence/admin-login.json`에 저장합니다.

## ERP 자원 관리 확장 — 2026-10-19 16:59 UTC

GPU 이력·OS 계정별 집계·예약 신청/수정/검토/승인/배정/취소·장비 설정·CLI 한도·API 비용·관리자 수동 잔액을 배포했습니다. 동일한 `LAB_GPU_URL`을 읽기 전용으로 사용합니다. 예약과 잔액의 새 원장은 메신저 DB에 저장하며 ERP와 자동 동기화하지 않습니다.

소스 백업: `.data/resources-backup/2026-10-19T16-48-17.979Z/`. 배포 직전 온라인 DB 백업: `.data/resources-backup/predeploy-2026-10-19T16-58-44.841Z/`. 새 해시 자산을 복사하고 `index.html`을 교체했으며 이전 자산을 유지했습니다. `lab-chat`, `lab-chat-demo`만 재시작했고 터널과 기존 GPU/ERP 서비스는 변경하지 않았습니다.

일반 스키마 3, 체험 스키마 2에서 모두 4로 이전했습니다. 이전 계정·메시지 내용의 해시 일치와 무결성 `ok`를 확인했습니다. 체험의 인증 없는 health 401은 기존 공유 접속 인증에 따른 응답입니다. 새 메뉴의 관리 기능도 서버 세션 인증과 역할 검사를 통과해야 합니다.

검증 결과는 [VALIDATION.md](VALIDATION.md), 기능별 ERP 대응과 권한·운영 경계는 [GPU.md](GPU.md)를 참조하세요. 배포 증거는 `.data/deploy/evidence/resources-before.json`, `resources-deployment.json`, `resources-public.json`입니다.

체험 사이트도 공유 접속 인증·샘플 로그인 후 이력 차트·예약 원장·AI 한도를 실제 Chrome에서 확인했습니다. 샘플 장비 4개, 이력 demo=true, JavaScript 예외 없음. 샘플 이력 간격 수정 후 체험 앱만 한 번 더 재시작했습니다. 근거: `.data/deploy/evidence/resources-public-demo.json`, `resources-public-demo.png`.

## 2026-10-20 데스크톱 시험판 연결

`desktop/`에 Electron 앱을 추가하고, 웹의 내 계정 화면과 `/#desktop-downloads`에 인증된 다운로드 UI를 연결했습니다. 앱은 일반 워크스페이스 `chat.damilab.cc`에 연결합니다. 데모에서는 같은 다운로드 파일을 볼 수 있지만 배포 앱이 데모 서버에 연결되지는 않습니다. 상세 빌드와 검증 경계는 [DESKTOP.md](DESKTOP.md)에 있습니다.

배포 전 SQLite 온라인 백업: `.data/desktop-backup/2026-10-20T02-23-27.395Z/{local,demo}`. 코드/기존 dist 사본: `.data/desktop-backup/2026-10-20T02-11-05.015Z/`. 새 assets를 추가한 뒤 index.html을 원자적으로 교체했고 `lab-chat`, `lab-chat-demo`만 재시작했습니다. 기존 asset 파일은 열린 클라이언트를 위해 유지했습니다. 배포 후 두 DB의 users/messages 내용 해시가 이전과 일치하고 `integrity_check=ok`였습니다. 공개 health 200, 비로그인 다운로드 목록 401, 공개 HTML과 배포 index의 해시 일치를 확인했습니다. 증거: `.data/deploy/evidence/desktop-{before,deployment}.json`.

설치 파일 저장소는 `.data/desktop-releases/`이며 DB와 분리됩니다. `scripts/publish-desktop.mjs`는 패키지를 검증한 후 목록을 원자적으로 교체합니다. 서버가 요청마다 manifest를 읽으므로 파일 게시를 위해 서버를 재시작할 필요가 없습니다. 게시 파일과 SHA-256은 `desktop-packages.json`, 일반·데모의 화면 및 다운로드 검증은 `desktop-public.json`에 기록합니다.

최종 공개 검증: 일반·데모 사이트 모두 로그인 후 세 플랫폼 카드 표시, ZIP 세 개의 HTTP Range 응답 206 및 첫 32바이트 일치, 첨부 다운로드 헤더, manifest의 크기/SHA-256 일치를 확인했습니다. 전체 ZIP은 로컬에서 CRC·SHA-256·내부 소스·아키텍처를 검증했으며, 공개망에서는 범위 응답을 검증했습니다. 로그아웃은 204, 이후 목록과 파일은 모두 401, 브라우저 pageerror는 0건입니다. 화면은 `desktop-public-{local,demo}.png`입니다.

실제 다운로드에서 발견한 `.data` 경로 404를 수정했습니다. 파일 제공 시 저장 루트와 파일명을 분리해 Express에 넘기며, 승인되지 않은 숨김 파일은 계속 거부합니다. 기존 첨부파일 다운로드도 동일한 수정에 포함했습니다. 숨김 디렉터리를 쓰는 API 회귀 테스트 33개와 ZIP Range 응답 검증을 통과했고, 서버 재배포 후 공개 다운로드가 동작했습니다. 최종 users/messages 해시와 DB 무결성은 `desktop-final.json`에서 확인했습니다.

## 2026-10-20 05:37 UTC — EXE·DMG 설치형 0.1.1 배포

기본 다운로드를 Windows x64 NSIS EXE와 macOS Apple Silicon·Intel DMG로 교체했습니다. [GitHub Actions 실행 39375371365](https://github.com/apple4ree/lab_chat/actions/runs/39375371365)의 소스 커밋 `9db04b1e0804e5c2c8d55a9079f112a9c3b4d64f`에서 세 플랫폼 모두 빌드와 네이티브 검증을 통과했습니다. Windows에서는 설치·시작 메뉴·실제 패키지 실행·제거를, Mac에서는 DMG 검증·마운트·Applications 링크·앱 복사·아키텍처·프레임워크 링크·ad-hoc 서명 검증·실제 패키지 실행을 확인했습니다. 모두 운영 로그인 화면과 렌더러 격리를 확인했으며 계정 로그인 없이 실행했습니다. Windows 체크아웃의 CRLF 변환은 `.gitattributes`에서 LF로 통일했습니다. 최종 게시 시 세 파일의 전체 SHA-256과 포함된 런타임 소스를 고정된 Git 커밋과 대조했습니다. 개발자 인증서 서명·Apple 공증·일반 사용자 환경의 SmartScreen/Gatekeeper 승인·자동 업데이트는 검증 또는 제공 범위에 포함되지 않습니다.

기존 화면과 목록 백업은 `.data/installer-backup/2026-10-20T05-28-35.696Z/`에 있습니다. 모든 파일 검증 후 manifest를 원자적으로 교체하고 새 웹 자산과 index를 배포했습니다. 서버 재시작 없이 이전 자산과 0.1.0 ZIP 파일을 보존했습니다. 운영·데모의 실제 Chrome에서 로그인 후 EXE 한 개와 DMG 두 개의 표시, 각 파일의 Range 206·로컬 바이트 일치·다운로드 헤더·DMG 푸터, 로그아웃 후 목록과 파일의 401, 브라우저 예외 0건을 확인했습니다. 공개 HTML은 배포 index와 일치하며 두 DB의 users/messages 해시 유지 및 `integrity_check=ok`를 확인했습니다. 전체 파일 검증은 로컬에서, 공개 전송 검증은 바이트 범위 요청으로 수행했습니다. 증거는 `.data/deploy/evidence/installers-{native-ci,packages,public,final}.json`과 `installers-public-{local,demo}.png`입니다. 로컬 검증은 데스크톱 정책 3개, 게시·다운로드 API 5개, 다운로드 브라우저 시나리오 2개, TypeScript 검사와 Vite 빌드가 통과했습니다.

## 2026-10-20 06:45 UTC — 화면 애니메이션과 전송 피드백

소스 커밋 `dd5ae2b5a65b80b787d1b75f6cecb323f26f0c5a`의 웹 빌드를 운영·데모에 배포했습니다. 버튼·메뉴·스레드·새 메시지 효과, 전송 성공 표시, GPU 막대 전환과 동작 줄이기를 추가했습니다. 구현과 로컬 검증 범위는 [MOTION.md](MOTION.md)에 있습니다. 새 자산을 추가하고 index를 원자적으로 교체했으며 서버 재시작과 설치 파일 변경은 하지 않았습니다. 이전 index 백업은 `.data/motion-backup/2026-10-20T06-43-03.393Z/`입니다.

두 공개 도메인에서 Chrome으로 대화상자 효과, 실행 중 동작 줄이기 설정 변경, 모바일 메뉴 열기·바깥 영역으로 닫기, 가로 넘침 없음, 배포 HTML 일치, JavaScript 예외 0건을 확인했습니다. 운영 메시지는 작성하지 않았습니다. 두 DB의 계정·메시지 해시 보존 및 무결성 `ok`를 확인했습니다. 증거는 `.data/deploy/evidence/motion-{before,public,data}.json`과 `motion-public-{local,demo}.png`입니다. 네이티브 앱 재실행 검증은 이번 배포 범위에 포함하지 않았습니다.

## 2026-10-20 07:25 UTC — 변경분 동기화와 용량 관리

소스 커밋 `b7e23fb`의 변경분 동기화·재접속 복구·전송 중복 방지·읽음/백그라운드 처리·GPU 조건부 조회·관리자 지표를 운영과 체험에 배포했습니다. [NETWORK.md](NETWORK.md)에 계약, 단일 브라우저 전후 측정과 용량 관리 절차를 기록했습니다.

배포 전 온라인 DB·첨부파일·기존 index 백업은 `.data/network-backup/2026-10-20T07-23-52.993Z/`입니다. 기존 자산을 보존하며 새 해시 자산을 추가한 뒤 `lab-chat`, `lab-chat-demo`만 재시작했습니다. 두 DB가 스키마 4에서 5로 이전되고 무결성 `ok`임을 확인한 후 index를 원자적으로 교체했습니다. 터널과 GPU/ERP 프로세스는 변경하지 않았습니다. 계정·메시지 전체 내용 해시는 배포 전과 일치했습니다.

두 실제 도메인에서 Chrome 로그인 후 각각 32초 동안 API 요청 0건, 최초/변경분 동기화 200, 관리자 지표 200, 변경 없는 GPU 조회 304, 자산 `public, max-age=31536000, immutable`, 공개 HTML과 배포 index 일치, JavaScript 예외 0건을 확인했습니다. 인증 전과 로그아웃 후 동기화 요청은 401입니다. 공개 통신 측정에서 SSE heartbeat는 API 요청 건수에 포함되지 않습니다.

EXE 한 개·DMG 두 개의 다운로드 UI와 Range 206, 로컬 파일 바이트·크기·manifest SHA-256 일치, 다운로드 헤더, DMG 푸터도 다시 확인했습니다. 로그아웃 후 목록·파일은 모두 401입니다. 설치 파일 자체는 재빌드하지 않았으며 Windows/macOS 네이티브 실행은 이번 배포 검증에 포함하지 않습니다.

증거: `.data/deploy/evidence/network-{before,data,public}.json`, `network-installers-public.json`. 설치 파일 보관 사본의 블록 공유 증거는 `.data/research/network-2026-10-20/installer-dedupe.json`입니다. 파일 경로·내용·inode·수정 시각을 유지하며 749,632,411 B의 동일 영역을 공유했고 게시 설치 파일·DB·백업은 대상에서 제외했습니다.

스키마 5를 도입했으므로 이전 스키마까지만 지원하는 서버 코드로 단순 재시작하는 롤백은 거부됩니다. 장애 시 현재 DB를 별도로 보존하고 새 위치에 백업을 복구해 검증한 후 전환해야 합니다. 배포 후 기록을 잃을 수 있는 운영 DB 덮어쓰기는 자동화하지 않았습니다.

## 2026-10-21 — GitHub Release 다운로드 연결

[v0.1.1 시험판 Release](https://github.com/apple4ree/lab_chat/releases/tag/v0.1.1)에 기존 검증된 EXE·DMG 3개와 SHA256SUMS.txt를 게시했습니다. 태그는 설치 파일의 실제 빌드 커밋 9db04b1e0804e5c2c8d55a9079f112a9c3b4d64f에 고정했습니다. GitHub asset digest와 로컬 전체 SHA-256을 대조한 뒤 공개했고, 익명 페이지 200·세 파일 Range 206·원본 바이트 및 체크섬 파일 일치를 확인했습니다.

운영·체험 다운로드 manifest와 화면을 연결하고 lab-chat·lab-chat-demo만 재시작했습니다. GitHub Release 링크와 설치 파일 링크, GitHub 파일의 Range 206·DMG 푸터, 로그아웃 후 기존 로컬 API의 401, 브라우저 예외 0건을 두 도메인에서 확인했습니다. GitHub 설치 파일은 공개 다운로드이며 메신저의 대화·첨부파일·계정 권한은 변경하지 않았습니다.

백업은 `.data/github-release-backup/2026-10-21T01-20-08.996Z/`이며 기존 index·manifest·온라인 DB·첨부파일을 포함합니다. 배포 후 계정·메시지 내용 해시 일치와 DB 무결성 ok를 확인했습니다. 증거는 `.data/github-release-0.1.1/`과 `.data/deploy/evidence/github-release-public.json`에 있습니다. 새 설치 파일 사본이나 의존성은 만들지 않았고, 현재 JS gzip은 95,601 B로 용량 예산을 통과했습니다.

## 2026-10-21 — 계정 비밀번호 변경 화면 보완

기존 내 계정의 비밀번호 변경 기능에 새 비밀번호 확인 입력, 불일치·현재 비밀번호 오류 표시, 10자 이상 안내와 처리 중 입력 잠금을 추가했습니다. 현재 비밀번호 검증·다른 세션 해제·현재 세션 재발급은 기존 서버 경로를 사용합니다. 운영자 전용 관리자 생성 함수는 로그인 아이디와 별도 표시 이름을 받을 수 있으며, 기존 계정의 이름·비밀번호·권한을 덮어쓰지 않습니다.

인증·계정 API 16개, 격리 브라우저의 초대 가입→확인 불일치→잘못된 현재 비밀번호→변경 성공→로그아웃→새 비밀번호 로그인 시나리오를 통과했습니다. TypeScript·Vite·용량 검사 통과. 현재 JS gzip 95,722 B이며 의존성·설치 파일 추가 없이 공유 웹 화면만 배포했습니다. 서버 재시작은 필요하지 않았고 이전 자산을 유지했습니다.

실제 운영 로그인·관리자 API 200·내 계정의 비밀번호 입력 3개·모바일 가로 넘침 없음·배포 HTML 일치·로그아웃 후 관리자 API 401·JavaScript 예외 0건을 확인했습니다. 운영 계정의 비밀번호를 테스트 목적으로 변경하지 않았습니다. 생성 전 온라인 DB와 기존 index를 백업했으며 기존 사용자 행·메시지 보존 및 무결성 ok를 확인했습니다. 비공개 증거는 `.data/deploy/evidence/account-password-public.json`, 백업은 `.data/account-backup/`에 있습니다.

## 관리자 도메인 변경 — 2026-10-21

운영·체험 서버에 관리자 접속 도메인 화면과 확인/적용 API를 반영했습니다. 실제 대표 주소는 `https://chat.damilab.cc` 그대로이며 DNS/Tunnel 설정을 변경하지 않았습니다. 신규 도메인은 소유권과 DNS/Tunnel 연결을 먼저 준비해야 합니다.

격리 서버 테스트 46개, 데스크톱 정책 테스트 5개, 브라우저 시나리오 10개, Linux Electron 실행 검증 7항목이 통과했습니다. 처음 숨김 경로 `.data/domain-build`에서 HTML 제공이 차단되어 테스트가 실패했고, `/tmp/dami-domain-build-20261021`로 테스트 산출물 경로를 옮겨 통과했습니다. 운영 앱은 기존과 같이 `dist`에서 제공합니다.

배포 전 `.data/domain-backup/20261021T015234Z`에 일반/체험 SQLite·첨부파일과 기존 dist를 백업했습니다. `lab-chat`과 `lab-chat-demo`만 재시작했습니다. 공개 HTML과 로컬 빌드의 일치, 공개 연결 설정 API의 대표 주소/revision 0, 실제 공인 HTTPS 도메인 확인 요청 성공을 검증했습니다. 배포 전후 계정·로그인명·채널·메시지·첨부파일·멤버십·예약 테이블 해시가 모두 일치했고 SQLite integrity는 ok입니다. 체험 공개 경로의 공유 인증 차단도 유지됩니다.

현재 JS gzip 비교 크기는 95,722 → 97,091 bytes, CSS는 9,201 → 9,391 bytes입니다. 기존 크기 예산을 통과했고 새 런타임 의존성을 추가하지 않았습니다. 실제 외부 도메인의 전환과 Windows/macOS에서 도메인 이전 전체 흐름은 아직 실행하지 않았습니다.

운영 관리자 로그인 후 **설정 → 접속 도메인 관리** 화면, 현재 주소, 입력란 표시와 브라우저 오류 없음도 확인했습니다. 이 확인에서 도메인 설정은 변경하지 않았고 사용한 로그인 세션은 로그아웃했습니다. 화면 증거: `.data/deploy/evidence/domain-admin-production.png`와 JSON.

[DAMI Chat v0.1.2](https://github.com/apple4ree/lab_chat/releases/tag/v0.1.2)를 게시했습니다. [GitHub 실행 39529959811](https://github.com/apple4ree/lab_chat/actions/runs/39529959811)의 Windows x64·macOS arm64·macOS x64 세 작업이 모두 성공했습니다. 태그/설치 파일 소스는 `e19668e314d654be9f071e58616f14a64fdb038c`입니다. 패키지에 새 `connection.cjs`가 포함되는지도 해시로 확인합니다.

설치 파일 및 체크섬 파일의 GitHub digest가 검증된 로컬 파일과 일치하며, 익명 Range 다운로드 206과 선두 바이트, 체크섬 파일 전체 일치를 확인했습니다. 운영 다운로드 manifest를 v0.1.2 GitHub Release로 연결했습니다. 이전 v0.1.1 설치 파일과 manifest는 복구를 위해 유지합니다. 새 설치 파일 크기: Windows 111,974,320 bytes, Mac arm64 128,647,039 bytes, Mac x64 134,193,004 bytes. 합계는 이전보다 1,835 bytes 작으며 패키지 압축 결과의 차이입니다. 정식 개발자 서명·Apple 공증·자동 업데이트 활성화는 이번 변경에 포함되지 않습니다.
