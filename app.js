/* ============================================================
   footprint-v2 — 정적 HTML + Leaflet + Supabase JS
   클라이언트 단독으로 모든 인터랙션을 처리해 즉시 반응한다.
   ============================================================ */

(() => {
  "use strict";

  // ── 설정 검증 ────────────────────────────────────────
  if (!window.FP_CONFIG) {
    document.body.innerHTML =
      "<pre style='padding:24px;font-family:monospace;'>" +
      "config.js 가 없습니다. config.example.js 를 복사해 config.js 를 만들고 키를 채워 주세요." +
      "</pre>";
    return;
  }
  const { SUPABASE_URL, SUPABASE_ANON_KEY, VWORLD_KEY } = window.FP_CONFIG;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    document.body.innerHTML =
      "<pre style='padding:24px;font-family:monospace;'>" +
      "SUPABASE_URL / SUPABASE_ANON_KEY 가 비어 있습니다." +
      "</pre>";
    return;
  }

  const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ── 상수 / 상태 ─────────────────────────────────────
  const TABLE = "footprints";
  const BUCKET = "footprint-images";
  const MAX_IMAGES = 4;
  const COMPRESS_SIZE = 400;       // 정사각 400px
  const COMPRESS_QUALITY = 0.85;   // JPEG quality
  const DEFAULT_CENTER = [37.34541, 127.08995];
  const ICON_SIZE = [48, 48];        // 정사각 마커 PNG 기준 (가로, 세로)
  const TEMP_ICON_SIZE = [52, 52];   // 등록 모드 임시 마커는 살짝 크게
  const TILE_OPACITY = 0.5;

  // ── 마커 이미지 설정 ────────────────────────────────
  // 사용자별 마커는 Supabase `user_markers` 테이블에 저장(user_name → marker 파일명).
  // 테이블이 아직 없거나 행이 없으면 아래 기본값으로 동작한다.
  const MARKER_TABLE = "user_markers";
  const MARKER_DIR = "image/";
  const DEFAULT_USER_MARKERS = {
    "운석": "apeach.png",
    "혜민": "tube.png",
  };
  // image/markers.js 가 로드되지 않았을 때의 안전망
  const MARKERS = (Array.isArray(window.FP_MARKERS) && window.FP_MARKERS.length
    ? window.FP_MARKERS
    : [
        { file: "tube.png", name: "튜브" },
        { file: "apeach.png", name: "어피치" },
      ]
  ).filter((m) => m && m.file);

  // 활동 사용자 전환 시 요구할 비밀번호 (간단한 흥미 요소 — 보안 목적 아님)
  const USER_PASSWORDS = {
    "운석": "0329",
    "혜민": "0906",
  };

  const state = {
    user: null,                     // 초기엔 무선택 — 둘 중 하나가 비밀번호로 인증돼야 설정됨
    isAdding: false,
    tempLatLng: null,
    tempMarker: null,
    activeId: null,
    rows: [],                       // Supabase 행 캐시
    rowById: new Map(),             // id → row
    markerById: new Map(),          // id → L.marker
    cluster: null,
    userMarkers: { ...DEFAULT_USER_MARKERS }, // user_name → 마커 파일명
  };

  // 모달 안 이미지 상태 (Add / Edit 각각)
  // editItems: { type: 'existing' | 'pending', url?, file?, objectUrl? }
  let addPendingFiles = [];
  let editItems = [];
  let editRemovedUrls = [];

  // ── 마커 아이콘 (PNG 그대로 사용, 파일별로 캐시) ─────────
  const iconCache = new Map();      // file → L.icon
  const tempIconCache = new Map();  // file → L.icon (등록 모드 임시 마커)

  function markerSrc(file) {
    return MARKER_DIR + encodeURIComponent(file);
  }
  function markerInfo(file) {
    return MARKERS.find((m) => m.file === file) || { file, name: file };
  }
  // 사용자의 현재 마커 파일명 (DB → 기본값 → 목록 첫 번째 순)
  function markerFileFor(userName) {
    return (
      state.userMarkers[userName] ||
      DEFAULT_USER_MARKERS[userName] ||
      (MARKERS[0] && MARKERS[0].file)
    );
  }

  function iconFor(userName) {
    const file = markerFileFor(userName);
    if (!iconCache.has(file)) {
      iconCache.set(
        file,
        L.icon({
          iconUrl: markerSrc(file),
          iconSize: ICON_SIZE,
          iconAnchor: [ICON_SIZE[0] / 2, ICON_SIZE[1]],
          popupAnchor: [0, -ICON_SIZE[1]],
          tooltipAnchor: [0, -ICON_SIZE[1] + 6],
          className: "fp-marker-img",   // 비율이 다른 이미지도 찌그러지지 않게 (object-fit)
        }),
      );
    }
    return iconCache.get(file);
  }

  // 임시 마커는 현재 사용자의 마커 + .fp-temp-host 클래스로 톤 변경
  function tempIconFor(userName) {
    const file = markerFileFor(userName);
    if (!tempIconCache.has(file)) {
      tempIconCache.set(
        file,
        L.icon({
          iconUrl: markerSrc(file),
          iconSize: TEMP_ICON_SIZE,
          iconAnchor: [TEMP_ICON_SIZE[0] / 2, TEMP_ICON_SIZE[1] - 2],
          className: "fp-marker-img fp-temp-host",
        }),
      );
    }
    return tempIconCache.get(file);
  }

  // ── 지도 초기화 ─────────────────────────────────────
  const map = L.map("map", {
    center: DEFAULT_CENTER,
    zoom: 12,
    zoomControl: true,
    preferCanvas: false,
  });

  if (VWORLD_KEY) {
    L.tileLayer(
      `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Base/{z}/{y}/{x}.png`,
      { attribution: "VWorld", opacity: TILE_OPACITY }
    ).addTo(map);
  } else {
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      opacity: TILE_OPACITY,
    }).addTo(map);
  }

  state.cluster = L.markerClusterGroup({
    maxClusterRadius: 80,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 17,
    chunkedLoading: true,
  });
  map.addLayer(state.cluster);

  // 클러스터 차원에서도 안전망. 빠른 hover 이동 때 잔류 툴팁을 모두 제거한다.
  state.cluster.on("mouseout", () => {
    state.cluster.eachLayer((m) => {
      if (m.closeTooltip) m.closeTooltip();
    });
  });

  // ── HTML 헬퍼 ──────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const escapeHtml = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  // ── 이미지 URL 직렬화 / 역직렬화 (image_url 콤마 구분) ─
  function parseImages(s) {
    if (!s) return [];
    return String(s)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  function joinImages(arr) {
    return (arr || []).filter(Boolean).join(",");
  }

  // ── Storage 헬퍼 ───────────────────────────────────
  function extractStoragePath(publicUrl) {
    if (!publicUrl) return null;
    const m = publicUrl.match(/\/object\/public\/footprint-images\/(.+?)(\?.*)?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function compressToSquare(file, size = COMPRESS_SIZE, quality = COMPRESS_QUALITY) {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = objectUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      // 원본이 정사각이 아니어도 가운데를 잘라 정사각으로
      const sourceSize = Math.min(img.width, img.height);
      const sourceX = (img.width - sourceSize) / 2;
      const sourceY = (img.height - sourceSize) / 2;
      ctx.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      return blob;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function uploadCompressed(footprintId, file) {
    const blob = await compressToSquare(file);
    const filename =
      Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 8) + ".jpg";
    const path = `${footprintId}/${filename}`;
    const { error } = await supa.storage.from(BUCKET).upload(path, blob, {
      contentType: "image/jpeg",
      cacheControl: "3600",
      upsert: false,
    });
    if (error) throw error;
    const { data } = supa.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  async function deleteImagesFromStorage(urls) {
    const paths = (urls || [])
      .map(extractStoragePath)
      .filter(Boolean);
    if (!paths.length) return;
    try {
      await supa.storage.from(BUCKET).remove(paths);
    } catch (e) {
      console.warn("이미지 삭제 일부 실패 (무시 가능):", e);
    }
  }

  async function deleteAllImagesForFootprint(id) {
    try {
      const { data, error } = await supa.storage.from(BUCKET).list(`${id}`, {
        limit: 100,
      });
      if (error || !data || !data.length) return;
      const paths = data.map((f) => `${id}/${f.name}`);
      await supa.storage.from(BUCKET).remove(paths);
    } catch (e) {
      console.warn("발자국 폴더 정리 일부 실패 (무시 가능):", e);
    }
  }

  function showToast(msg, ms = 2200) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.hidden = true;
    }, ms);
  }

  function setStatus(text) {
    const el = $("#map-status");
    if (!text) {
      el.hidden = true;
      el.textContent = "";
    } else {
      el.textContent = text;
      el.hidden = false;
    }
  }

  // ── 사용자 배지 ─────────────────────────────────────
  function renderUserBadge() {
    const badge = $("#user-badge");
    if (state.user == null) {
      badge.innerHTML = "💭 활동할 사용자를 선택해 주세요";
      badge.classList.remove("user-hm");
      badge.classList.add("user-none");
      return;
    }
    const file = markerFileFor(state.user);
    badge.innerHTML =
      `<img class="user-badge-img" src="${escapeHtml(markerSrc(file))}" alt="" />` +
      `<span><b>${escapeHtml(state.user)}</b> 으로 활동 중</span>`;
    badge.classList.toggle("user-hm", state.user === "혜민");
    badge.classList.remove("user-none");
  }

  // 무선택/사용자 변경 시 UI 토글 (등록 버튼, 열려 있는 팝업 권한 표시, 테마 전환)
  function renderActiveUserUI() {
    const hasUser = state.user != null;
    $("#btn-add-mode").disabled = !hasUser;
    $("#btn-change-marker").hidden = !hasUser;
    if (!hasUser && state.isAdding) {
      setAddMode(false);
    }
    // body[data-user] 로 테마 토큰 스왑 (CSS 가 알아서 색감을 바꿈)
    if (state.user === "운석") {
      document.body.dataset.user = "ws";
    } else if (state.user === "혜민") {
      document.body.dataset.user = "hm";
    } else {
      delete document.body.dataset.user;
    }
    // 라디오를 state.user 와 정합 시킴 (취소/오답 시 원래대로 복원)
    document.querySelectorAll("input[name='user']").forEach((r) => {
      r.checked = r.value === state.user;
    });
    // 열려 있는 팝업이 있으면 권한 변화 반영
    if (state.activeId != null) {
      const m = state.markerById.get(state.activeId);
      if (m && m.isPopupOpen()) {
        m.setPopupContent(popupHtml(state.rowById.get(state.activeId)));
      }
    }
  }

  // ── 활성 마커 강조 ──────────────────────────────────
  function setActive(id) {
    // 이전 강조 제거 (베이스 + 사용자별 클래스 모두)
    document
      .querySelectorAll(".fp-active-host")
      .forEach((el) =>
        el.classList.remove(
          "fp-active-host",
          "fp-active-ws",
          "fp-active-hm",
        ),
      );
    document.body.classList.remove("fp-spotlight-on");

    state.activeId = id;
    if (id == null) return;

    const m = state.markerById.get(id);
    if (!m) return;
    const row = state.rowById.get(id);
    const userClass =
      row && row.user_name === "운석" ? "fp-active-ws" : "fp-active-hm";
    document.body.classList.add("fp-spotlight-on");
    const tryAttach = (n = 0) => {
      const el = m.getElement && m.getElement();
      if (el) {
        el.classList.add("fp-active-host", userClass);
      } else if (n < 10) {
        // 클러스터에 묶여 있어 element 가 아직 없으면 잠깐 후 재시도
        setTimeout(() => tryAttach(n + 1), 80);
      }
    };
    tryAttach();
  }

  // ── 팝업 HTML ──────────────────────────────────────
  function popupHtml(row) {
    const isWs = row.user_name === "운석";
    const stars = "⭐".repeat(Number(row.rating || 0));
    const isOwner = row.user_name === state.user;
    const userIcon = isWs ? "🩵" : "🩷";
    const cls = "fp-popup " + (isWs ? "user-ws" : "user-hm");

    const images = parseImages(row.image_url);
    const imagesHtml = images.length
      ? `<div class="popup-images">
           ${images
             .map(
               (u) =>
                 `<img class="popup-thumb" src="${escapeHtml(u)}" alt="" loading="lazy" />`,
             )
             .join("")}
         </div>`
      : "";

    const actions = isOwner
      ? `<div class="actions">
           <button class="edit" data-action="edit" data-id="${row.id}">✏️ 수정</button>
           <button class="del"  data-action="delete" data-id="${row.id}">🗑 삭제</button>
         </div>`
      : `<div class="ownership-note">
           본인이 등록한 발자국만 수정·삭제할 수 있어요.
         </div>`;

    return `<div class="${cls}">
      <div class="place">${escapeHtml(row.place_name || "")}</div>
      <div class="meta">${userIcon} <b>${escapeHtml(row.user_name)}</b>
        · 📅 ${escapeHtml(row.visit_date || "-")} · ${stars || "별점 없음"}
      </div>
      <div class="review">${escapeHtml(row.review || "-")}</div>
      ${imagesHtml}
      ${actions}
    </div>`;
  }

  // ── 마커 추가 / 갱신 / 제거 ──────────────────────────
  function addMarker(row) {
    const marker = L.marker([row.lat, row.lng], {
      icon: iconFor(row.user_name),
      title: row.place_name || "",
    });
    marker.bindTooltip(row.place_name || "", {
      direction: "top",
      offset: [0, -8],
      opacity: 1,
      permanent: false,
      sticky: false,
      interactive: false,
    });
    marker.bindPopup(() => popupHtml(row), { maxWidth: 360 });

    // 마우스를 떼는 즉시 툴팁이 사라지도록 명시 처리. 가끔 마커 사이를 빠르게
    // 오갈 때 툴팁이 두 개 보이는 현상을 방지한다.
    marker.on("mouseout", () => marker.closeTooltip());
    marker.on("popupopen", () => {
      marker.closeTooltip();   // 팝업과 툴팁이 함께 뜨지 않게
      setActive(row.id);
    });
    marker.on("popupclose", () => {
      if (state.activeId === row.id) setActive(null);
    });

    state.cluster.addLayer(marker);
    state.markerById.set(row.id, marker);
  }

  function clearMarkers() {
    state.cluster.clearLayers();
    state.markerById.clear();
  }

  function rebuildMarkers() {
    clearMarkers();
    state.rowById.clear();
    state.rows.forEach((r) => {
      state.rowById.set(r.id, r);
      addMarker(r);
    });
  }

  // ── Supabase CRUD ───────────────────────────────────
  // 사용자별 마커 매핑을 DB 에서 읽어 state.userMarkers 에 반영.
  // 테이블이 없거나 실패하면 기본값 유지. 반환값: 매핑이 바뀌었는지 여부.
  async function loadUserMarkers() {
    let data, error;
    try {
      ({ data, error } = await supa
        .from(MARKER_TABLE)
        .select("user_name, marker"));
    } catch (e) {
      error = e;
    }
    if (error) {
      console.warn(
        `[${MARKER_TABLE}] 불러오기 실패 — 기본 마커로 동작합니다. README 의 SQL 을 확인해 주세요.`,
        error,
      );
      return false;
    }
    const next = { ...DEFAULT_USER_MARKERS };
    (data || []).forEach((r) => {
      if (r && r.user_name && r.marker) next[r.user_name] = r.marker;
    });
    const prev = state.userMarkers;
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const changed = [...keys].some((k) => prev[k] !== next[k]);
    state.userMarkers = next;
    return changed;
  }

  // 마커 매핑이 바뀌었을 때 지도/배지/임시 마커 아이콘을 갱신
  function refreshMarkerIcons() {
    state.markerById.forEach((m, id) => {
      const row = state.rowById.get(id);
      if (row) m.setIcon(iconFor(row.user_name));
    });
    if (state.tempMarker) state.tempMarker.setIcon(tempIconFor(state.user));
    renderUserBadge();
    // setIcon 으로 element 가 교체되면 강조 클래스가 빠지므로 다시 적용
    if (state.activeId != null) setActive(state.activeId);
  }

  async function loadAll() {
    setStatus("불러오는 중...");
    // 발자국과 사용자 마커 매핑을 병렬로 읽고, 둘 다 끝난 뒤 마커를 그린다.
    const [{ data, error }] = await Promise.all([
      supa.from(TABLE).select("*").order("id", { ascending: true }),
      loadUserMarkers(),
    ]);
    setStatus(null);
    renderUserBadge();
    if (error) {
      showToast(`불러오기 실패: ${error.message}`);
      console.error(error);
      return;
    }
    state.rows = data || [];
    rebuildMarkers();
  }

  async function insertFootprint(payload) {
    const { data, error } = await supa
      .from(TABLE)
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    state.rows.push(data);
    state.rowById.set(data.id, data);
    addMarker(data);
    return data;
  }

  async function updateFootprint(id, patch) {
    const { data, error } = await supa
      .from(TABLE)
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    // 메모리 갱신 + 마커 다시 그리기
    const idx = state.rows.findIndex((r) => r.id === id);
    if (idx >= 0) state.rows[idx] = data;
    state.rowById.set(id, data);
    const old = state.markerById.get(id);
    if (old) {
      state.cluster.removeLayer(old);
      state.markerById.delete(id);
    }
    addMarker(data);
    return data;
  }

  async function deleteFootprint(id) {
    const { error } = await supa.from(TABLE).delete().eq("id", id);
    if (error) throw error;
    // 발자국 삭제 후 Storage 폴더 통째로 정리
    deleteAllImagesForFootprint(id);
    state.rows = state.rows.filter((r) => r.id !== id);
    state.rowById.delete(id);
    const old = state.markerById.get(id);
    if (old) {
      state.cluster.removeLayer(old);
      state.markerById.delete(id);
    }
    if (state.activeId === id) setActive(null);
  }

  // ── 등록 모드 ───────────────────────────────────────
  function setAddMode(on) {
    state.isAdding = on;
    $("#btn-add-mode").hidden = on;
    $("#add-hint").hidden = !on;
    $("#map").classList.toggle("is-adding", on);
    if (on) {
      setStatus("📍 지도를 클릭해 위치를 선택하세요");
      // 진행 중이던 팝업 닫고 강조 해제
      map.closePopup();
      setActive(null);
    } else {
      setStatus(null);
      removeTempMarker();
    }
  }

  function removeTempMarker() {
    if (state.tempMarker) {
      map.removeLayer(state.tempMarker);
      state.tempMarker = null;
    }
    state.tempLatLng = null;
  }

  function placeTempMarker(latlng) {
    removeTempMarker();
    state.tempLatLng = latlng;
    state.tempMarker = L.marker(latlng, { icon: tempIconFor(state.user) }).addTo(map);
    state.tempMarker.bindTooltip("새 발자국 위치", {
      direction: "top",
      offset: [0, -8],
      opacity: 1,
      permanent: true,
    });
  }

  // ── 평점 위젯 ──────────────────────────────────────
  function bindRating(form) {
    const rating = form.querySelector(".rating");
    if (!rating) return;
    let value = 0;
    rating.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        value = Number(btn.dataset.value);
        paint();
      });
      btn.addEventListener("mouseenter", () => paint(Number(btn.dataset.value)));
      btn.addEventListener("mouseleave", () => paint());
    });
    function paint(hover = null) {
      const display = hover ?? value;
      rating.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", Number(b.dataset.value) <= display);
      });
    }
    rating._get = () => value;
    rating._set = (v) => {
      value = Number(v) || 0;
      paint();
    };
  }

  // ── 모달 ────────────────────────────────────────────
  function openDialog(id) {
    const dlg = document.getElementById(id);
    if (!dlg.open) dlg.showModal();
  }
  function closeDialog(id) {
    const dlg = document.getElementById(id);
    if (dlg.open) dlg.close();
  }

  // 모든 X / 취소 버튼에 닫기 바인딩
  document.querySelectorAll("[data-close]").forEach((b) => {
    b.addEventListener("click", () => closeDialog(b.dataset.close));
  });

  // ── 추가 모달 ───────────────────────────────────────
  bindRating($("#form-add"));

  function renderAddImageGrid() {
    const grid = $("#add-image-grid");
    grid.innerHTML = "";
    addPendingFiles.forEach((f, i) => {
      // 미리보기 — 압축 전 원본 ObjectURL
      const url = URL.createObjectURL(f);
      const div = document.createElement("div");
      div.className = "thumb";
      div.innerHTML = `<img src="${url}" alt="" />
        <button type="button" class="rm" data-index="${i}" aria-label="제거">×</button>`;
      grid.appendChild(div);
    });
    $("#add-image-add-btn").disabled = addPendingFiles.length >= MAX_IMAGES;
  }

  $("#add-image-add-btn").addEventListener("click", () => {
    $("#add-image-input").click();
  });
  $("#add-image-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const f of files) {
      if (!f.type.startsWith("image/")) {
        showToast(`이미지 파일만 첨부할 수 있어요 — ${f.name}`);
        continue;
      }
      if (addPendingFiles.length >= MAX_IMAGES) {
        showToast(`최대 ${MAX_IMAGES}장까지 첨부할 수 있어요.`);
        break;
      }
      addPendingFiles.push(f);
    }
    renderAddImageGrid();
  });
  $("#add-image-grid").addEventListener("click", (e) => {
    const rm = e.target.closest(".rm");
    if (rm) {
      addPendingFiles.splice(Number(rm.dataset.index), 1);
      renderAddImageGrid();
      return;
    }
    const img = e.target.closest("img");
    if (img) openLightbox(img.src);
  });

  function openAddModal(lat, lng) {
    const form = $("#form-add");
    form.reset();
    form.querySelector(".rating")._set(0);
    addPendingFiles = [];
    renderAddImageGrid();
    $("#add-coord").textContent = `선택한 위치 · ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    $("#add-error").hidden = true;
    const today = new Date().toISOString().slice(0, 10);
    form.querySelector("input[name='visit_date']").value = today;
    openDialog("dialog-add");
    setTimeout(() => form.querySelector("input[name='place_name']").focus(), 80);
  }

  $("#form-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const rating = form.querySelector(".rating")._get();
    const errEl = $("#add-error");
    const submitBtn = $("#add-submit");

    if (!data.place_name || !data.place_name.trim()) {
      errEl.textContent = "장소 이름을 입력해 주세요.";
      errEl.hidden = false;
      return;
    }
    if (!rating) {
      errEl.textContent = "별점을 선택해 주세요. ⭐";
      errEl.hidden = false;
      return;
    }
    if (!state.tempLatLng) {
      errEl.textContent = "지도에서 위치를 먼저 선택해 주세요.";
      errEl.hidden = false;
      return;
    }
    submitBtn.classList.add("is-busy");
    submitBtn.textContent = "💾 저장 중...";
    try {
      // 1) DB INSERT — 우선 이미지 없이 행 생성 (id 확보)
      const newRow = await insertFootprint({
        user_name: state.user,
        lat: state.tempLatLng.lat,
        lng: state.tempLatLng.lng,
        place_name: data.place_name.trim(),
        visit_date: data.visit_date,
        review: data.review || "",
        rating,
        image_url: "",
      });

      // 2) 이미지 압축 + 업로드
      if (addPendingFiles.length) {
        submitBtn.textContent = "📷 이미지 업로드 중...";
        const urls = await Promise.all(
          addPendingFiles.map((f) => uploadCompressed(newRow.id, f)),
        );
        await updateFootprint(newRow.id, { image_url: joinImages(urls) });
      }

      closeDialog("dialog-add");
      setAddMode(false);
      addPendingFiles = [];
      showToast("발자국이 저장되었어요!");
    } catch (err) {
      console.error(err);
      errEl.textContent = `저장 실패: ${err.message || err}`;
      errEl.hidden = false;
    } finally {
      submitBtn.classList.remove("is-busy");
      submitBtn.textContent = "💾 저장";
    }
  });

  // 추가 모달이 X 로 닫혀도 등록 모드는 유지(다시 다른 위치 클릭 가능)
  document
    .getElementById("dialog-add")
    .addEventListener("close", () => {
      // 임시 마커는 유지 — 다시 클릭하면 좌표가 갱신됨
    });

  // ── 수정 모달 ───────────────────────────────────────
  bindRating($("#form-edit"));

  function renderEditImageGrid() {
    const grid = $("#edit-image-grid");
    grid.innerHTML = "";
    editItems.forEach((it, i) => {
      const div = document.createElement("div");
      div.className = "thumb";
      const src = it.type === "existing" ? it.url : it.objectUrl;
      div.innerHTML = `<img src="${escapeHtml(src)}" alt="" />
        <button type="button" class="rm" data-index="${i}" aria-label="제거">×</button>`;
      grid.appendChild(div);
    });
    $("#edit-image-add-btn").disabled = editItems.length >= MAX_IMAGES;
  }

  $("#edit-image-add-btn").addEventListener("click", () => {
    $("#edit-image-input").click();
  });
  $("#edit-image-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const f of files) {
      if (!f.type.startsWith("image/")) {
        showToast(`이미지 파일만 첨부할 수 있어요 — ${f.name}`);
        continue;
      }
      if (editItems.length >= MAX_IMAGES) {
        showToast(`최대 ${MAX_IMAGES}장까지 첨부할 수 있어요.`);
        break;
      }
      editItems.push({
        type: "pending",
        file: f,
        objectUrl: URL.createObjectURL(f),
      });
    }
    renderEditImageGrid();
  });
  $("#edit-image-grid").addEventListener("click", (e) => {
    const rm = e.target.closest(".rm");
    if (rm) {
      const i = Number(rm.dataset.index);
      const item = editItems[i];
      if (item && item.type === "existing") {
        editRemovedUrls.push(item.url);
      }
      if (item && item.type === "pending" && item.objectUrl) {
        URL.revokeObjectURL(item.objectUrl);
      }
      editItems.splice(i, 1);
      renderEditImageGrid();
      return;
    }
    const img = e.target.closest("img");
    if (img) openLightbox(img.src);
  });

  function openEditModal(row) {
    const form = $("#form-edit");
    form.reset();
    form.querySelector(".rating")._set(Number(row.rating) || 0);
    form.querySelector("input[name='place_name']").value = row.place_name || "";
    form.querySelector("input[name='visit_date']").value = row.visit_date || "";
    form.querySelector("textarea[name='review']").value = row.review || "";
    $("#edit-coord").textContent =
      `${row.lat.toFixed(5)}, ${row.lng.toFixed(5)} · 작성자: ${row.user_name}`;
    $("#edit-error").hidden = true;
    form.dataset.id = row.id;
    // 이미지 상태 초기화
    editItems = parseImages(row.image_url).map((url) => ({
      type: "existing",
      url,
    }));
    editRemovedUrls = [];
    renderEditImageGrid();
    openDialog("dialog-edit");
  }

  $("#form-edit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const rating = form.querySelector(".rating")._get();
    const id = form.dataset.id;
    const errEl = $("#edit-error");
    const submitBtn = $("#edit-submit");

    if (!data.place_name || !data.place_name.trim()) {
      errEl.textContent = "장소 이름을 입력해 주세요.";
      errEl.hidden = false;
      return;
    }
    if (!rating) {
      errEl.textContent = "별점을 선택해 주세요. ⭐";
      errEl.hidden = false;
      return;
    }
    if (editItems.length > MAX_IMAGES) {
      errEl.textContent = `사진은 최대 ${MAX_IMAGES}장까지 가능합니다.`;
      errEl.hidden = false;
      return;
    }

    submitBtn.classList.add("is-busy");
    submitBtn.textContent = "💾 저장 중...";
    try {
      // 1) 새 이미지 업로드
      const pending = editItems.filter((x) => x.type === "pending");
      let newUrls = [];
      if (pending.length) {
        submitBtn.textContent = "📷 이미지 업로드 중...";
        newUrls = await Promise.all(
          pending.map((p) => uploadCompressed(id, p.file)),
        );
      }
      // 2) 최종 image_url 결정 (남긴 기존 + 신규)
      const keptUrls = editItems
        .filter((x) => x.type === "existing")
        .map((x) => x.url);
      const finalImageUrl = joinImages([...keptUrls, ...newUrls]);

      // 3) DB 업데이트
      await updateFootprint(id, {
        place_name: data.place_name.trim(),
        visit_date: data.visit_date,
        review: data.review || "",
        rating,
        image_url: finalImageUrl,
      });

      // 4) 제거된 기존 이미지를 Storage 에서 삭제
      if (editRemovedUrls.length) {
        deleteImagesFromStorage(editRemovedUrls);
      }

      closeDialog("dialog-edit");
      showToast("발자국이 수정되었어요!");
      const m = state.markerById.get(id) || state.markerById.get(Number(id));
      if (m) m.openPopup();
    } catch (err) {
      console.error(err);
      errEl.textContent = `수정 실패: ${err.message || err}`;
      errEl.hidden = false;
    } finally {
      submitBtn.classList.remove("is-busy");
      submitBtn.textContent = "💾 저장";
    }
  });

  // ── 삭제 모달 ───────────────────────────────────────
  let pendingDeleteId = null;
  function openDeleteModal(row) {
    pendingDeleteId = row.id;
    $("#delete-msg").textContent = `'${row.place_name || "-"}' 발자국을 삭제할까요?`;
    openDialog("dialog-delete");
  }

  $("#btn-confirm-delete").addEventListener("click", async () => {
    if (pendingDeleteId == null) return;
    try {
      await deleteFootprint(pendingDeleteId);
      closeDialog("dialog-delete");
      showToast("삭제되었어요.");
    } catch (err) {
      console.error(err);
      showToast(`삭제 실패: ${err.message || err}`);
    } finally {
      pendingDeleteId = null;
    }
  });

  // ── 팝업 안의 수정/삭제 버튼 / 썸네일 위임 처리 ──────
  // Leaflet 은 팝업 콘텐츠가 동적이라 위임이 가장 안전.
  document.body.addEventListener("click", (e) => {
    // 팝업 안 썸네일 → 라이트박스
    const thumb = e.target.closest(".popup-thumb");
    if (thumb) {
      openLightbox(thumb.getAttribute("src"));
      return;
    }
    const btn = e.target.closest(".fp-popup .actions button");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const row =
      state.rowById.get(id) ||
      state.rowById.get(Number(id)) ||
      state.rowById.get(String(id));
    if (!row) return;
    if (row.user_name !== state.user) {
      showToast("본인이 등록한 발자국만 수정·삭제할 수 있어요.");
      return;
    }
    if (action === "edit") {
      map.closePopup();
      openEditModal(row);
    } else if (action === "delete") {
      map.closePopup();
      openDeleteModal(row);
    }
  });

  // ── 라이트박스 ──────────────────────────────────────
  const lightbox = $("#lightbox");
  const lightboxImg = $("#lightbox-img");
  function openLightbox(src) {
    if (!src) return;
    lightboxImg.src = src;
    if (!lightbox.open) lightbox.showModal();
  }
  function closeLightbox() {
    if (lightbox.open) lightbox.close();
    lightboxImg.src = "";
  }
  lightbox.addEventListener("click", () => closeLightbox());
  // 모달 안 썸네일 클릭은 그리드 컨테이너의 click 위임에서 openLightbox 를 호출.

  // ── 지도 클릭 (등록 모드일 때만 좌표 수집) ────────────
  map.on("click", (e) => {
    if (!state.isAdding) return;
    placeTempMarker(e.latlng);
    openAddModal(e.latlng.lat, e.latlng.lng);
  });

  // ── 좌측 메뉴 이벤트 ────────────────────────────────
  // 라디오를 클릭해도 곧장 사용자가 바뀌지 않고 비밀번호 모달이 뜬다.
  // 통과해야만 state.user 가 갱신됨.
  let pendingUserSelection = null;

  function promptForUser(targetUser) {
    if (!targetUser || !(targetUser in USER_PASSWORDS)) return;
    pendingUserSelection = targetUser;
    $("#password-msg").textContent =
      `'${targetUser}' 으로 활동하려면 비밀번호를 입력해 주세요.`;
    $("#password-error").hidden = true;
    const form = $("#form-password");
    form.reset();
    openDialog("dialog-password");
    setTimeout(() => form.querySelector("input[name='password']").focus(), 80);
  }

  document.querySelectorAll("input[name='user']").forEach((r) => {
    r.addEventListener("change", (e) => {
      const target = e.currentTarget.value;
      if (target === state.user) return;       // 이미 해당 사용자면 아무 동작 X
      promptForUser(target);
    });
  });

  $("#form-password").addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = e.currentTarget.password.value;
    const target = pendingUserSelection;
    if (target && USER_PASSWORDS[target] === pw) {
      state.user = target;
      pendingUserSelection = null;
      closeDialog("dialog-password");
      renderUserBadge();
      renderActiveUserUI();
      showToast(`${target} 으로 전환됐어요`);
      // 인증 직후 마커 고르기 화면 제시
      openMarkerPicker();
    } else {
      $("#password-error").textContent = "비밀번호가 올바르지 않아요.";
      $("#password-error").hidden = false;
      e.currentTarget.password.select();
      // UI 변동 없음 — 라디오는 그대로(상태와 어긋난 상태) 두고 close 시 복원
    }
  });

  // 비밀번호 모달이 어떤 경로(취소/X/Esc)로든 닫히면 라디오를 state.user 에 다시 맞춘다
  document.getElementById("dialog-password").addEventListener("close", () => {
    pendingUserSelection = null;
    renderActiveUserUI();
  });

  // ── 마커 고르기 모달 ────────────────────────────────
  // 본인이 현재 쓰는 마커 / 다른 유저가 쓰는 마커는 50% 투명 + 선택 불가.
  // 후보 목록은 image/markers.js(window.FP_MARKERS) 기준 — 항목이 늘면 그리드가 자동 확장.
  let markerPickSelected = null;

  // file → 사용 중인 user_name (본인 포함)
  function markerOwners() {
    const owners = new Map();
    Object.entries(state.userMarkers).forEach(([user, file]) => {
      if (file) owners.set(file, user);
    });
    return owners;
  }

  function renderMarkerPicker() {
    const grid = $("#marker-grid");
    const owners = markerOwners();
    const me = state.user;
    let availableCount = 0;

    grid.innerHTML = MARKERS.map((m) => {
      const owner = owners.get(m.file);
      const isMine = owner === me;
      const isTaken = owner != null && !isMine;
      const isLocked = isMine || isTaken;
      if (!isLocked) availableCount++;
      const isSelected = !isLocked && m.file === markerPickSelected;
      const tag = isMine
        ? `<span class="marker-tag mine">내 마커</span>`
        : isTaken
          ? `<span class="marker-tag taken">${escapeHtml(owner)} 사용 중</span>`
          : "";
      const stateLabel = isMine
        ? " (현재 내 마커)"
        : isTaken
          ? ` (${owner} 사용 중)`
          : "";
      const cls = [
        "marker-option",
        isLocked ? "is-locked" : "",
        isMine ? "is-mine" : "",
        isSelected ? "is-selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button type="button" class="${cls}" role="radio"
          data-file="${escapeHtml(m.file)}"
          aria-checked="${isSelected}"
          aria-label="${escapeHtml((m.name || m.file) + stateLabel)}"
          ${isLocked ? "disabled" : ""}>
          <span class="marker-thumb">
            <img src="${escapeHtml(markerSrc(m.file))}" alt="" loading="lazy" />
          </span>
          <span class="marker-name">${escapeHtml(m.name || m.file)}</span>
          ${tag}
        </button>`;
    }).join("");

    const current = markerInfo(markerFileFor(me));
    $("#marker-msg").textContent = availableCount
      ? `'${me}' 님이 지도에 남길 마커를 골라 주세요. 지금은 '${current.name}' 마커를 쓰고 있어요.`
      : `지금은 새로 고를 수 있는 마커가 없어요. image 폴더에 마커를 추가하면 여기에 나타나요. (현재: '${current.name}')`;
    $("#marker-submit").disabled = !markerPickSelected;
  }

  async function openMarkerPicker() {
    if (state.user == null) return;
    markerPickSelected = null;
    $("#marker-error").hidden = true;
    renderMarkerPicker();
    openDialog("dialog-marker");
    // 다른 유저가 그사이 마커를 바꿨을 수 있으니 최신 매핑으로 다시 그림
    const changed = await loadUserMarkers();
    if (changed) {
      refreshMarkerIcons();
      // 고르던 마커가 방금 다른 유저에게 선점됐으면 선택 해제
      if (markerPickSelected && markerOwners().has(markerPickSelected)) {
        markerPickSelected = null;
      }
      if ($("#dialog-marker").open) renderMarkerPicker();
    }
  }

  $("#marker-grid").addEventListener("click", (e) => {
    const opt = e.target.closest(".marker-option");
    if (!opt || opt.disabled) return;
    markerPickSelected = opt.dataset.file;
    $("#marker-error").hidden = true;
    renderMarkerPicker();
    // 다시 그린 뒤에도 키보드 포커스 유지
    const again = $("#marker-grid").querySelector(
      `.marker-option[data-file="${CSS.escape(markerPickSelected)}"]`,
    );
    if (again) again.focus();
  });

  $("#marker-submit").addEventListener("click", async () => {
    const file = markerPickSelected;
    const user = state.user;
    if (!file || user == null) return;
    const errEl = $("#marker-error");
    const btn = $("#marker-submit");

    // 저장 직전 최신 상태로 한 번 더 중복 확인
    await loadUserMarkers();
    const owner = markerOwners().get(file);
    if (owner != null && owner !== user) {
      markerPickSelected = null;
      refreshMarkerIcons();
      renderMarkerPicker();
      errEl.textContent = `'${owner}' 님이 방금 이 마커를 선택했어요. 다른 마커를 골라 주세요.`;
      errEl.hidden = false;
      return;
    }

    btn.classList.add("is-busy");
    btn.textContent = "💾 저장 중...";
    try {
      const { error } = await supa
        .from(MARKER_TABLE)
        .upsert(
          { user_name: user, marker: file, updated_at: new Date().toISOString() },
          { onConflict: "user_name" },
        );
      if (error) throw error;
      state.userMarkers = { ...state.userMarkers, [user]: file };
      refreshMarkerIcons();
      closeDialog("dialog-marker");
      showToast(`'${markerInfo(file).name}' 마커로 바꿨어요!`);
    } catch (err) {
      console.error(err);
      const code = err && err.code;
      if (code === "23505") {
        // UNIQUE(marker) 위반 — 다른 유저가 동시에 같은 마커를 저장
        await loadUserMarkers();
        markerPickSelected = null;
        refreshMarkerIcons();
        renderMarkerPicker();
        errEl.textContent = "다른 유저가 이미 사용 중인 마커예요. 다른 마커를 골라 주세요.";
      } else if (code === "42P01" || code === "PGRST205") {
        errEl.textContent = `'${MARKER_TABLE}' 테이블이 없어요. README 의 SQL 을 먼저 실행해 주세요.`;
      } else {
        errEl.textContent = `마커 저장 실패: ${(err && err.message) || err}`;
      }
      errEl.hidden = false;
    } finally {
      btn.classList.remove("is-busy");
      btn.textContent = "✅ 이 마커로 변경";
    }
  });

  document.getElementById("dialog-marker").addEventListener("close", () => {
    markerPickSelected = null;
  });

  $("#btn-change-marker").addEventListener("click", () => openMarkerPicker());

  $("#btn-add-mode").addEventListener("click", () => {
    if (state.user == null) {
      showToast("먼저 활동할 사용자를 선택해 주세요.");
      return;
    }
    setAddMode(true);
  });
  $("#btn-cancel-add").addEventListener("click", () => {
    setAddMode(false);
    closeDialog("dialog-add");
  });

  // ── 첫 페인트 ──────────────────────────────────────
  renderUserBadge();
  renderActiveUserUI();
  loadAll();

  // ── ESC 처리 ──────────────────────────────────────
  // 다이얼로그(라이트박스/추가/수정/삭제) 가 열려 있으면 native ESC 가 알아서 닫는다.
  // 그 외에 등록 모드만 활성일 때는 ESC 로 모드 종료.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.querySelector("dialog[open]")) return;
    if (state.isAdding) setAddMode(false);
  });
})();
