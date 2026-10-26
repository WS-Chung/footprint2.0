# 우리 발자국 v2 — 정적 HTML + Leaflet + Supabase JS

Streamlit 의존성을 떼어내고 클라이언트 단독으로 동작하도록 다시 만든 버전입니다.
DB(Supabase)와 마커 이미지는 기존 프로젝트와 그대로 호환되며, 같은 키를 그대로 쓰면 됩니다.

## 구조

```
footprint-v2/
├── index.html            # 메인 (지도 + 메뉴 + 모달)
├── style.css             # 테마 (아이보리 + 모카, 하트 배경 패턴)
├── app.js                # 모든 로직 (Leaflet + Supabase + 모달/CRUD)
├── config.example.js     # 설정 템플릿 (복사해서 config.js 로 사용)
├── image/
│   ├── markers.js        # 마커 후보 목록 (파일명 · 이름 · 후광 색)
│   ├── apeach.png        # 어피치 (운석 기본) — 분홍 후광
│   ├── tube.png          # 튜브 (혜민 기본) — 노랑 후광
│   ├── chiikawa.png      # 치이카와 — 밝은 은색 후광
│   ├── hachiware.png     # 하치와레 — 밝은 파랑 후광
│   ├── usagi.png         # 우사기 — 밝은 베이지 후광
│   └── momonga.png       # 모몽가 — 옅은 하늘색 후광
├── vercel.json           # Vercel 정적 배포 설정 (선택)
└── README.md
```

## 로컬 실행

1. `config.example.js` 를 복사해 `config.js` 를 만들고 본인 키를 채웁니다.
   ```js
   window.FP_CONFIG = {
     SUPABASE_URL:      "https://YOUR-PROJECT.supabase.co",
     SUPABASE_ANON_KEY: "YOUR-SUPABASE-ANON-KEY",
     VWORLD_KEY:        "YOUR-VWORLD-API-KEY"   // 비우면 OSM 으로 폴백
   };
   ```
2. 정적 파일이라 어떤 정적 서버든 OK 입니다. 가장 간단한 방법:
   ```
   python -m http.server 8000
   ```
   브라우저에서 http://localhost:8000 열기.

## Vercel 배포

이 폴더를 GitHub 저장소에 올리고 Vercel 에서 import → 자동 빌드.
`config.js` 는 `.gitignore` 에 올라가 있으니 다음 중 한 방법으로 처리:

- **간단**: `config.js` 를 직접 커밋. (`.gitignore` 에서 제외) Supabase RLS 가 anon key 노출을 전제로 한 설계라 문제 없음. VWorld 키도 동일.
- **권장(공개 레포)**: 별도 비공개 레포로 보관하거나, Vercel 대시보드에서 `config.js` 를 직접 업로드.

## Supabase 테이블 / RLS

기존 v1 과 동일한 스키마를 그대로 사용합니다.

```sql
-- 이미 만들어져 있으니 신규 생성 시에만 실행
CREATE TABLE public.footprints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_name   text NOT NULL,
  lat         float NOT NULL,
  lng         float NOT NULL,
  place_name  text,
  visit_date  date,
  review      varchar(50),
  rating      int CHECK (rating >= 1 AND rating <= 5),
  image_url   text,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE public.footprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone can read"   ON public.footprints FOR SELECT USING (true);
CREATE POLICY "anyone can insert" ON public.footprints FOR INSERT WITH CHECK (true);
CREATE POLICY "anyone can update" ON public.footprints FOR UPDATE USING (true);
CREATE POLICY "anyone can delete" ON public.footprints FOR DELETE USING (true);
```

### 사용자별 마커 (`user_markers`)

사용자마다 고른 마커 파일명을 저장합니다. `marker` 에 UNIQUE 제약이 있어
두 사용자가 같은 마커를 쓰는 것을 DB 차원에서도 막습니다.
마커를 바꾸면 그 사용자의 기존 발자국도 모두 새 마커로 보입니다(`footprints` 테이블은 변경 없음).

```sql
CREATE TABLE public.user_markers (
  user_name   text PRIMARY KEY,
  marker      text NOT NULL UNIQUE,      -- image 폴더 기준 파일명 (예: 'tube.png')
  updated_at  timestamptz DEFAULT now()
);
ALTER TABLE public.user_markers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone can read"   ON public.user_markers FOR SELECT USING (true);
CREATE POLICY "anyone can insert" ON public.user_markers FOR INSERT WITH CHECK (true);
CREATE POLICY "anyone can update" ON public.user_markers FOR UPDATE USING (true);

-- 기존 마커 그대로 시작 (운석 = 어피치, 혜민 = 튜브)
INSERT INTO public.user_markers (user_name, marker) VALUES
  ('운석', 'apeach.png'),
  ('혜민', 'tube.png');
```

테이블이 없으면 앱은 위 기본값으로 표시만 하고, 마커 변경 저장 시 안내 메시지를 띄웁니다.

## 마커 목록

마커는 6종으로 확정되어 `image/markers.js` 에 하드코딩되어 있습니다.
각 항목은 `{ file, name, glow, glowPeak }` 이고, `glow` / `glowPeak` 는 지도에서 마커를 클릭했을 때
숨쉬듯 깜빡이는 후광 색(`"R, G, B"`)입니다. 색을 바꾸고 싶으면 이 값만 고치면 됩니다.

정적 호스팅에서는 브라우저가 폴더 목록을 읽을 수 없어서 이 목록에 있는 이미지만 후보로 나옵니다.
선택 화면은 3열 그리드(6종 = 3×2)입니다. 마커 이미지는 가로 1 : 세로 1.3 비율이며
지도에는 어피치·튜브 40×52, 치이카와·하치와레·우사기·모몽가 50×65(`markers.js` 의 `size`),
배지에는 30×39, 선택 화면에는 50×65 로 표시됩니다.
마커 고르기 화면은 마지막으로 사용한 마커(`user_markers`)가 기본 선택된 상태로 열립니다.

## 동작 요약

- **사용자 선택**: 좌측 라디오 (운석 / 혜민) → 비밀번호 인증 후 팝업 없이 가장 최근에 쓰던 마커로 바로 지도 표시
- **마커 고르기**: "📍 새 발자국 등록" 아래 "🎨 내 마커 바꾸기" 버튼으로만 열림. 마지막으로 쓴 마커가 기본 선택, 다른 사용자가 쓰는 마커는 50% 투명 + 선택 불가
- **마커 클릭**: 정보 + 수정/삭제 버튼이 든 팝업이 그 자리에 떠요. 본인 발자국이 아니면 액션 비활성.
- **새 발자국 등록**: 좌측 "📍 새 발자국 등록" → 지도 클릭 → 좌표 위에 입력 모달.
- **수정/삭제**: 팝업 액션 또는 모달 내부 흐름.
- **클러스터링**: 줌 16 이하에서는 묶여 보임. 줌 17 이상이면 모두 펼쳐짐.
- **호버 툴팁**: 손글씨 폰트(Caveat) + 자체 스타일.
- **활성 마커 강조**: 팝업 열리면 해당 마커에 캐릭터별 색 후광 + 다른 마커 dim.

## 성능 비교 (v1 대비)

| 동작 | v1 (Streamlit) | v2 (정적) |
|------|-----------------|-----------|
| 메뉴/라디오 변경 | 0.7~1.5s | < 50ms |
| 마커 클릭 → 팝업 | 0.5~1s | 50~100ms |
| 지도 빈 영역 클릭 → 입력 모달 | 0.5~1s | 50~100ms |
| 저장 후 마커 반영 | 1~2s (rerun) | 100~200ms (Supabase RTT 만) |

WebSocket / rerun 왕복이 사라져서 사실상 즉시 반응합니다.
