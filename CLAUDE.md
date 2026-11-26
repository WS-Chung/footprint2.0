# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

"우리 발자국" — 두 사용자(운석 / 혜민)가 방문한 장소를 지도 위 캐릭터 마커로 기록하는 취미용 웹앱.
**빌드 단계 없는 순수 정적 사이트**(HTML + 바닐라 JS + CSS)이며, 백엔드는 Supabase(DB + Storage)를 브라우저에서 직접 호출한다.

이전 버전(v1)은 Python/Streamlit 앱이었고, 로컬 소스는 삭제했다. v2는 v1과 같은 Supabase 스키마를 그대로 쓰므로, 코드나 README에 남아 있는 "v1 호환" 표현(예: `footprints` 테이블 구조, `Number(id)` 폴백)은 그 흔적이다.

## 실행 / 배포

- package.json, 번들러, 린터, 테스트가 **없다**. 검증은 브라우저에서 직접 확인한다.
- 로컬 실행 (이 폴더에서):
  ```
  python -m http.server 8000
  ```
  → http://localhost:8000
- 배포: Vercel 정적 호스팅 (`vercel.json`은 cleanUrls + `Cache-Control: max-age=0` 헤더만 설정). 빌드 명령 없음.
- git 저장소의 루트는 이 폴더(`footprint-v2/`)이고 기본 브랜치는 `main`이다. `.gitattributes`는 `text=auto`라서 Windows(CRLF) 작업 파일도 저장소에는 LF로 들어간다.

## 아키텍처

### 스크립트 로드 순서와 전역 객체 (`index.html` 하단)

ES 모듈이 아니라 `<script>` 태그 순서에 의존한다:

1. CDN: Leaflet 1.9.4 → leaflet.markercluster 1.5.3 → `@supabase/supabase-js@2` (전역 `L`, `window.supabase`)
2. `config.js` → `window.FP_CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY, VWORLD_KEY }`
3. `image/markers.js` → `window.FP_MARKERS` (마커 후보 목록)
4. `app.js` → 모든 로직이 하나의 IIFE 안에 있음

### 지도 (오픈 API)

- 타일: **VWorld WMTS** `https://api.vworld.kr/req/wmts/1.0.0/{VWORLD_KEY}/Base/{z}/{y}/{x}.png` (y/x 순서 주의). `VWORLD_KEY`가 비어 있으면 OpenStreetMap으로 폴백.
- 타일 투명도 0.5(`TILE_OPACITY`), 기본 중심 `DEFAULT_CENTER`.
- 모든 발자국 마커는 `L.markerClusterGroup`에 들어간다(줌 17 이상에서 클러스터 해제). 클러스터 안의 마커는 DOM 요소가 없을 수 있어서 `setActive()`가 `getElement()`를 재시도한다.

### 상태와 데이터 흐름 (`app.js`)

- 단일 `state` 객체: `rows`(DB 행 캐시), `rowById`, `markerById`(id → L.marker), `userMarkers`(user_name → 마커 파일명), `user`, 등록 모드 관련 값.
- 시작 시 `loadAll()`이 `footprints` 전체와 `user_markers`를 병렬로 읽고 마커를 그린다. 이후 CRUD는 전체 재조회 없이 **로컬 캐시와 해당 마커만 갱신**한다(`insertFootprint` / `updateFootprint`는 마커를 제거 후 `addMarker`로 다시 추가).
- 팝업 HTML은 문자열로 생성(`popupHtml`)하며, 팝업 안 수정/삭제 버튼과 썸네일 클릭은 `document.body`의 **이벤트 위임**으로 처리한다. 사용자 입력을 HTML에 넣을 때는 `escapeHtml`을 사용한다.
- 모달은 전부 네이티브 `<dialog>`이며 `[data-close="<dialog id>"]` 버튼이 자동으로 닫기에 바인딩된다.

### Supabase

- 테이블 `footprints`: `id uuid, user_name, lat, lng, place_name, visit_date, review varchar(50), rating 1~5, image_url, created_at`. 전체 SQL은 `README.md` 참고.
- 테이블 `user_markers`: `user_name PK, marker UNIQUE, updated_at`. 테이블이 없거나 읽기에 실패하면 `DEFAULT_USER_MARKERS`로 동작한다. 저장은 `upsert(onConflict: user_name)`이고, 에러 코드 `23505`(마커 중복), `42P01`/`PGRST205`(테이블 없음)를 별도로 처리한다.
- RLS는 select/insert/update/delete 모두 `true` — 즉 **anon key만 있으면 누구나 모든 행을 수정할 수 있다**.
- Storage 버킷 `footprint-images`, 경로 `{footprint_id}/{랜덤}.jpg`. 버킷 이름은 `BUCKET` 상수와 `extractStoragePath`의 정규식 두 곳에 하드코딩되어 있다.

### 이미지 처리 흐름

- `image_url`은 **콤마로 구분된 public URL 문자열**이다(`parseImages` / `joinImages`). 발자국당 최대 4장.
- 업로드 전 캔버스로 가운데를 잘라 400px 정사각 JPEG(품질 0.85)로 압축한다(`compressToSquare`).
- 등록: ① 이미지 없이 INSERT해서 id 확보 → ② 이미지를 `{id}/` 경로에 업로드 → ③ `image_url` UPDATE.
- 수정: 새 이미지 업로드 → 남은 기존 URL + 새 URL로 UPDATE → 제거된 이미지는 Storage에서 삭제(실패해도 무시).
- 삭제: 행 삭제 후 Storage의 `{id}/` 폴더를 통째로 정리.

### 사용자 / 권한 모델

- 사용자 전환은 라디오 선택 → 비밀번호 모달(`USER_PASSWORDS`, 클라이언트에 하드코딩). 코드 주석에도 적혀 있듯이 **보안 목적이 아닌 재미 요소**다.
- "본인 발자국만 수정·삭제"는 `row.user_name === state.user` 비교로 **클라이언트에서만** 검사한다.
- 두 사용자 이름이 여러 곳에 하드코딩되어 있어서, 사용자를 추가·변경하려면 다음을 모두 고쳐야 한다:
  `index.html` 라디오, `USER_PASSWORDS`, `DEFAULT_USER_MARKERS`, `renderActiveUserUI`(`body[data-user]`를 `ws`/`hm`으로 매핑), `renderUserBadge`(`user-hm` 클래스), `popupHtml`(`운석`이 아니면 모두 혜민 스타일), `style.css`의 `body[data-user="ws"|"hm"]` 테마, README의 `user_markers` 초기 INSERT.

### 마커 시스템

- 후보 목록은 `image/markers.js`의 `{ file, name, size, glow, glowPeak }`. 정적 호스팅에서는 폴더 목록을 읽을 수 없으므로 **이 목록에 등록된 이미지만** 선택 화면에 나온다.
- `file` 값은 DB(`user_markers.marker`)에 그대로 저장되므로 **사용 중인 이미지 파일명은 바꾸면 안 된다**.
- 마커 이미지 비율은 가로 1 : 세로 1.3. `iconAnchor`는 아래 가운데(발끝)이다. 등록 모드의 임시 마커는 10% 크게 표시된다(`TEMP_ICON_SCALE`).
- 사용자 마커가 바뀌면 `refreshMarkerIcons()`가 모든 마커 아이콘을 교체한다(`footprints` 테이블은 바뀌지 않음). 마커 고르기 모달을 열 때와 저장 직전에 `loadUserMarkers()`로 다른 기기의 변경 사항을 다시 확인한다.
- 활성 마커 강조: 팝업이 열리면 `body.fp-spotlight-on`(다른 마커는 흐리게) + 해당 마커 요소에 `.fp-active-host`와 인라인 CSS 변수 `--fp-glow` / `--fp-glow-peak`(`"R, G, B"` 문자열)을 넣어 후광 애니메이션을 준다.

### 테마 (`style.css`)

- 색은 모두 CSS 변수 토큰이다. `:root`는 사용자를 선택하지 않은 상태(아이보리+모카), `body[data-user="ws"]`는 하늘색, `body[data-user="hm"]`는 분홍색으로 토큰을 덮어쓴다. JS는 `data-user` 속성만 바꾼다.
- 폰트: Quicksand / Pretendard(본문), Dongle(툴팁 손글씨 스타일). 모두 CDN에서 불러온다.

## 알려진 불일치 / 주의사항

- README는 `config.example.js`를 복사해서 `config.js`를 만들라고 하지만 `config.example.js`는 **존재하지 않는다**. 현재 `config.js`(실제 키 포함)만 있고, 그 파일 머리 주석은 템플릿용 문구 그대로다.
- README는 `config.js`가 `.gitignore`에 있다고 하지만 실제로는 **추적 대상**이다. 정적 배포(Vercel)가 이 파일을 그대로 서빙해야 해서 의도적으로 무시 목록에 넣지 않았다. 안에는 실제 Supabase / VWorld 키가 들어 있으니 **공개 저장소에 올리기 전에 반드시 확인한다**.
- `footprints.id`는 uuid(문자열)인데, 코드 곳곳에서 `Number(id)` 폴백 조회를 한다(v1 호환용 방어 코드로 보임).
- 코드 주석, UI 문구, README는 모두 한국어로 작성되어 있다. 새로 작성하는 주석과 문구도 한국어로 맞춘다.
