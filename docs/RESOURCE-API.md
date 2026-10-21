# 자원 등록·수정 API

웹과 데스크톱은 같은 API와 SQLite 자원 원장을 사용한다. **자원 → 서버 사양 → 자원 등록·관리**에서 서버와 GPU를 추가하거나 수정한다. 관리자와 서버 관리자는 등록·수정·GPU 예약 허용/중지를 할 수 있고, 일반 구성원은 조회와 자신의 예약 신청을 할 수 있다. 서버 관리자 지정, 계정·도메인 관리, API 잔액 수정, 예약 승인 권한은 이번 변경으로 확대하지 않는다.

## 엔드포인트

| 메서드·경로 | 동작 | 권한 |
| --- | --- | --- |
| `GET /api/resources/catalog` | 등록 서버·GPU와 `canManageResources` 조회 | 로그인한 구성원 |
| `POST /api/resources/servers` | 서버 등록 | 관리자 또는 서버 관리자 |
| `PUT /api/resources/servers/:host` | 서버 등록 정보 수정 | 관리자 또는 서버 관리자 |
| `POST /api/resources/inventory` | 기존 서버 아래 GPU 등록 | 관리자 또는 서버 관리자 |
| `PUT /api/resources/inventory/:id` | GPU 이름·사양·담당자·예약 허용 여부 수정 | 관리자 또는 서버 관리자 |
| `POST /api/resources/history/batch` | GPU 1~6개 이력을 같은 시간 범위로 조회 | 로그인한 구성원 |

기존 `GET /api/resources/servers`는 관측값과 등록 사양을 구분하여 제공한다. `GET /api/resources/management`의 `canManageResources`로 장비 설정 가능 여부를 알 수 있다. 실제 권한은 모든 쓰기 요청 시 서버에서 다시 검사한다. 역할 회수는 이미 열린 화면에도 다음 쓰기 요청부터 적용된다.

인증은 기존 로그인 세션 쿠키를 사용한다. 쓰기 요청에는 `Content-Type: application/json`, `X-Lab-Request: 1`이 필요하며 브라우저 `Origin`은 허용된 워크스페이스 주소여야 한다. 무인 서비스용 API 토큰이나 공개 쓰기 API는 제공하지 않는다. 비밀번호·SSH 개인 키·수집 토큰은 이 API에 입력하지 않는다.

## 서버 등록

`POST /api/resources/servers` 요청 예시:

```json
{
  "host": "lab-gpu-02",
  "label": "공용 학습 서버",
  "hosting": "local",
  "note": "담당자와 사용 일정 조율",
  "ownerId": null,
  "cpuModel": "등록할 CPU 모델",
  "cpuCores": 32,
  "memoryGiB": 512,
  "storageGiB": 4096
}
```

`host`, `label`, `hosting`은 필수다. `hosting`은 `local`, `cloud`, `unknown` 중 하나다. 식별자에는 공백·경로 문자를 사용할 수 없고 최대 100자다. `host`는 수집기 보고 식별자와 대소문자까지 일치해야 같은 서버로 연결된다. `label`만 표시용 이름이며 바꿀 수 있다. 선택한 담당자는 책임자 정보로만 저장되고 서버 관리자 역할이 자동 부여되지는 않는다.

사양 숫자는 선택 사항이며 미등록은 `null` 또는 생략한다. GiB는 1024³ 바이트 단위다. CPU 코어는 정수다. 생성 응답은 HTTP 201과 저장된 서버 정보이며, `version`은 1부터 시작한다. 응답 원장의 필드명은 `owner_id`, `cpu_model`, `cpu_cores`, `memory_gib`, `storage_gib`다.

수정은 같은 편집 필드를 `PUT /api/resources/servers/lab-gpu-02`로 보내되 최신 `version`을 포함한다. 사양을 지우려면 `null`, 텍스트를 지우려면 빈 문자열을 보낸다. `host` 변경은 금지된다. 서버 목록의 `inventoryConnected`는 운영 설정에 해당 CPU/RAM 수집 연결이 등록되어 있는지를 나타내며 실시간 연결 성공을 보장하지 않는다.

## GPU 등록과 예약 연결

`POST /api/resources/inventory` 요청 예시:

```json
{
  "host": "lab-gpu-02",
  "gpuIndex": 0,
  "label": "학습 GPU 0",
  "model": "NVIDIA H200",
  "memoryGiB": 140,
  "notes": "실험 종료 후 예약 상태 확인",
  "ownerId": null,
  "enabled": true
}
```

서버가 먼저 등록되어 있어야 한다. `host`, `gpuIndex`, `label`, `enabled`는 필수다. 같은 `(host, gpuIndex)`는 하나의 GPU만 가리킨다. 이후 수집 보고가 도착해도 기존 GPU ID·예약·이름을 재생성하거나 덮어쓰지 않는다. GPU 응답의 등록 사양은 `declared_model`, `declared_memory_gib`이며 관측값과 별도다.

수정 요청에는 최신 `version`을 포함한다. 서버·GPU 번호는 변경할 수 없다. 기존 장비 설정 클라이언트가 `model`/`memoryGiB`를 생략하면 등록 사양은 유지된다. `enabled: false`는 신규 신청·승인을 막지만 기존 승인·배정·처리 이력은 보존하며 실행 중인 작업을 종료하지 않는다. 삭제 API는 제공하지 않는다.

예약의 요청 VRAM은 관측된 전체 용량을 우선으로 검사하고, 관측값이 없으면 직접 등록한 전체 용량을 참고한다. 이 검사는 현재 사용 가능 여부를 보장하지 않는다.

## 연결과 데이터 소유권

`server_catalog`는 표시 이름·서버 구분·담당자·직접 입력 사양의 원장이다. `research_resources`는 기존 GPU ID와 예약 관계를 소유하며 `resource_specs`는 추가 등록 사양을 저장한다. 자동 발견과 직접 등록은 `resource-catalog.mjs`에서 하나의 경로로 병합한다.

기존 `LAB_SERVER_TARGETS_FILE`의 구분·메모는 원장에 처음 들어올 때만 초기값으로 가져온다. 이후 화면에서 수정한 값이 설정 파일의 오래된 값으로 덮어써지지 않는다. 실제 로컬/SSH 수집 연결 설정은 계속 운영자 설정이 소유한다. 등록 API로 임의 주소에 접속하거나 명령을 실행하지 않는다.

등록만 된 서버의 상태는 확인 대기이며 RAM/VRAM 가용량을 만들지 않는다. 첫 보고가 없는 수동 등록 서버는 장애로 오인해 알리지 않는다. 자동 수집이 연결된 뒤에는 기존 보고 중단·복구 알림을 따른다. 새 원격 장비의 실시간 수집은 별도의 연결 설정이 필요하다.

## 충돌·검증·감사

`401`은 로그인 필요, `403`은 권한/요청 출처 오류, `404`는 없는 서버·GPU, `400`은 잘못된 필드다. 중복 등록이나 오래된 `version`은 `409`이며 자동 덮어쓰기 대신 목록을 다시 받아 검토한다. 수집 경계와 동일하게 서버 100대, 서버별 GPU 64개, 전체 GPU 1024개를 수동 등록 한도로 적용한다.

등록·수정은 트랜잭션으로 처리하고 작업자·대상·행위를 관리 기록에 남긴다. 잘못된 사양이 있으면 GPU 생성과 감사 기록을 함께 되돌린다. `test/resource-catalog.test.mjs`와 `test/browser/resource-catalog.spec.mjs`가 권한, 역할 회수, 충돌, 예약 보존, 미수집 표시와 실제 등록 화면을 격리 환경에서 검증한다.

## GPU 이력 묶음 조회

`POST /api/resources/history/batch`는 상태를 변경하지 않는 조회다. 로그인 세션, JSON 본문, `X-Lab-Request: 1`과 허용된 브라우저 Origin을 사용한다. 일시적 연결 오류에는 재시도할 수 있다.

```json
{
  "period": "day",
  "targets": [{"host": "pro_6000_dgu", "index": 0}, {"host": "pro_6000_dgu", "index": 1}]
}
```

`period`는 `hour`, `day`(기본값), `week`, `month` 중 하나다. `targets`는 중복 없는 1~6개의 장비이며 `index`는 숫자 정수다. 이력 대상 목록에 없는 장비는 등록되어 있더라도 `404`다. 대상 전체를 먼저 검증하여 잘못된 요청에 일부 이력을 읽지 않는다. 요청 수·응답 크기를 제한하기 위해 화면과 동일한 비교 개수 한도를 적용한다.

응답은 `{ "series": [{ "host": "...", "index": 0, "result": {...} }] }`다. 요청 순서를 유지하고 각 `result`는 기존 단일 조회와 같은 `data`, `fetchedAt`, `demo`, `from`, `to`, `bucketMs`와 제공자가 반환한 출처 정보를 포함한다. 모든 GPU에 공통 `from`/`to`를 사용하되 실제 집계 간격 `bucketMs`는 제공자 값을 유지한다. 장비당 최대 602개 집계점이며 미수집 값과 구간은 보간하지 않는다.

하나라도 조회에 실패하면 전체 요청이 실패하고 화면은 오류를 표시한다. 이전 결과를 현재 값으로 대신 보여주지 않는다. 선택 변경 시 이전 요청을 취소하고 늦은 응답이 화면을 덮어쓰지 않게 한다. `GET /api/resources/history?host=...&gpu=0&period=day`는 같은 검증·조회 경로로 계속 지원한다.

## 조회 비용

변경 없는 장비 목록은 DB 쓰기 트랜잭션이나 UUID 생성 없이 조회한다. 장비 식별자는 매번 현재 DB에서 확인하므로 다른 연결에서 등록한 자원도 반영하며 관측값의 최신성은 기존 수집 경로가 판단한다. 예약 관리 조회는 현재 예약을 한 번의 SQL로 조회하고 장비별로 연결한다. 시간 경계에서 예약을 종료·만료하는 기존 처리는 유지한다. 측정 방법과 범위는 [RESOURCE-PERFORMANCE.md](RESOURCE-PERFORMANCE.md)를 참고한다.
