/* 이 파일을 `config.js` 로 복사한 뒤 본인 키로 채워 주세요.
 *
 * - SUPABASE_URL / SUPABASE_ANON_KEY : Supabase 프로젝트 설정에서 anon key 사용.
 *   RLS 정책으로 보안 경계를 잡는 구조라 anon key 는 클라이언트 노출이 전제됩니다.
 * - VWORLD_KEY : 비워두면 OpenStreetMap 으로 자동 폴백합니다.
 *
 * 정적 호스팅(Vercel/Netlify/GitHub Pages 등)에서는 이 파일을 함께 배포하면 됩니다.
 */

window.FP_CONFIG = {
  SUPABASE_URL:      "https://nhfoilaqgramxafgaood.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5oZm9pbGFxZ3JhbXhhZmdhb29kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM4MDQsImV4cCI6MjA4OTUxOTgwNH0.12oCxXkka3MRuyl53bQ8HSLDfzm6JJ58LVfprsUJQcQ",
  VWORLD_KEY:        " 946DEA81-64BF-33E8-BE41-F32B097A90EE"   // 선택. 비우면 OSM 사용.
};
