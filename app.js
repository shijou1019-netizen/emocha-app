// えもちゃっとライブ スマホ版（閲覧だけ）の本体。index.html から 2026-10-14 に切り出した（CSP で script-src 'self' にするため）。
//   supabase-js は ./vendor/supabase.js（UMD 版。npm の @supabase/supabase-js と同じ版）を index.html が先に読み、window.supabase に入っている。
//   外部 CDN（esm.sh）は使わない（公式サイトと同じ「外部読み込みなし」の決まり）。
"use strict";

// 版（設定タブに出す。拡張機能の package.json の版 + "-web"。tests/webapp.test.js が一致を確かめる）
const WEB_VERSION = "0.16.3-web";

// 他のサイトの枠（iframe）の中で開かれたら、枠から抜け出す（クリックジャッキング対策。meta の CSP では frame-ancestors が効かないため）
if (window.top !== window.self) {
  try { window.top.location = window.location; } catch { document.documentElement.hidden = true; }
}

(() => {
  "use strict";

  document.getElementById("webVersion").textContent = `版 ${WEB_VERSION}`;
  // 読み込み画面は、ここでは閉じない。準備ができてから本体側が閉じる（2026-10-19）
})();

// supabase-js（./vendor/supabase.js）。版は tests/webapp.test.js が package.json と一致することを確かめる
const { createClient } = window.supabase;

(() => {
  "use strict";

  // ============================================================
  // 画面に出すデータの置き場（名前は試作時代の DUMMY のまま）
  //   2026-10-15 まで架空の数字が入っていたが、ログイン前に本物のように見えてしまうのでやめた（第三者レビューの指摘）。
  //   開いた直後・ログアウト後は空（applyStats(EMPTY_PAYLOAD)）、ログイン後は Supabase から取れた分で埋める。
  // ============================================================
  const DUMMY = {
    profile: {
      displayName: "",
      rankingOptIn: false,
      indexOrder: [],
    },
    plan: "free", // "free" | "premium"
    achievements: {
      totalWatchMinutes: 0, // 累計視聴時間
      totalComments: 0, // コメント送信数
      hotMomentCount: 0, // 激熱経験回数
    },
    today: null, // { watchMs, commentCount, feverCount }（user_daily_activity。ログインして取れるまでは非表示）
    dailyHistory: [], // [{ date, watchMs, feverCount }]（ヒートマップ用。直近90日）
    // チャンネル別の累計。points はプレミアム中の視聴から計算した獲得ポイント
    channels: [],
    activity: [], // [{ date, watchMs, commentCount, commonPoints, channelPoints }]（推し活グラフ用）
    streak: {
      current: 0,
      longest: 0,
      tier: "none", // "gold" | "silver" | "bronze" | "none"
    },
    // 獲得ポイント実績。common = 共通ポイント（廃止・常に 0）、channels = チャンネルごとの累計獲得（視聴時間から計算）
    points: {
      common: 0,
      commonSpent: 0,
      channels: [],
    },
  };
  // loadRealStats の fetcher が返す並びと同じ: [statsData, todayData, historyData, activityData, profileData]
  const EMPTY_PAYLOAD = [[], null, [], [], null];

  const TIER_LABEL = { gold: "金クラス", silver: "銀クラス", bronze: "銅クラス", none: "クラス未認定" };
  const TIER_GOAL = { gold: Infinity, silver: 30, bronze: 7, none: 3 };
  const AVATAR_COLORS = ["#ff7a18", "#8b5cff", "#3f8cff", "#ff3f81", "#26b57a", "#e0a52c", "#4d6bff", "#c2447a"];
  const HEATMAP_DAYS = 90;
  const LOG_DAILY_PAGE = 14;
  const LOG_SIGNED_OUT = "ログインすると、あなたの記録が見られます。";
  // 未ログイン・ログアウト後は false（ログのカードは数字を出さず案内文）。ログインして取り込み始めたら true
  let statsSignedIn = false;
  let logDailyShown = LOG_DAILY_PAGE;

  
  // ============================================================
  // 小さなフォーマッタ
  // ============================================================
  function formatMinutes(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h.toLocaleString("ja-JP")}時間${m}分`;
  }

  // ミリ秒 →「X時間Y分」（0 時間なら「Y分」だけ）。ヒートマップの詳細表示用
  function formatWatchDuration(ms) {
    const totalMinutes = Math.round(ms / 60000);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return h > 0 ? `${h}時間${m}分` : `${m}分`;
  }

  function formatCount(n) {
    return `${n.toLocaleString("ja-JP")}`;
  }

  function initialOf(name) {
    return name.trim().charAt(0) || "?";
  }

  function colorFor(index) {
    return AVATAR_COLORS[index % AVATAR_COLORS.length];
  }

  // ============================================================
  // Supabase クライアント（Google ログイン・実績データの取得）
  //   anon key は公開してよい鍵（テーブルは RLS で自分の行しか読み書きできない。supabase/migrations 参照）。
  //   セッションは supabase-js が自身で localStorage に持つ（iOS の ITP で消えても、単に「未ログイン」に戻るだけ。
  //   このファイルは Netlify 等にそのまま置く 1 枚の静的ファイルなので、拡張機能側の鍵の埋め込み方（build.mjs）は使えず、
  //   ここに直書きする。実運用では anon key が変わったらここも書き換える
  // ============================================================
  const SUPABASE_URL = "https://kpldczfykhjlkonwvucb.supabase.co";
  const SUPABASE_ANON_KEY =
    "sb_publishable_7xbGUSoFR09_zOPNt4IqRQ_hzDPeIO4";

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // flowType: "pkce" … ログインの戻りで、トークンを URL（#access_token=…）に出さず、1 回きりの code で受け取る（2026-10-14）
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
  });

  // 日付は端末のローカルの暦日（src/core/streak.js の localDateString と同じ規則。この PWA は
  // 単体の静的ファイルとして配る前提なので、拡張機能側のモジュールを import せずここに同じ計算を持つ）
  function localDateString(ms) {
    const d = new Date(ms);
    const pad2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // ============================================================
  // 1 日 1 回だけサーバーへ取りに行く（2026-10-14 依頼者決定: 「きのうまでの記録が見られればよい」）
  //   その日の分を一度取ったら localStorage に控え、同じ日のうちは控えを出す。日付が変わると取り直す。
  //   控えはログアウトで消す（共用の端末で次の人に見えないように）。Service Worker のキャッシュには入れない。
  //   無料枠の消費と、拡張機能の利用者への影響を小さく保つための仕組みでもある（1 人 1 日 1 回）。
  // ============================================================
  const SNAPSHOT_PREFIX = "emochat.web.snapshot:";
  const SNAPSHOT_VERSION = 3; // 控えの形を変えたら上げる（古い形の控えは捨てて取り直す）。2 = 2026-10-14 チャンネルのページ（cheer_count・index_order）/ 3 = 2026-10-15 一部失敗の控え（順位なし等）を捨てる
  function snapshotKey(user, name) {
    return `${SNAPSHOT_PREFIX}${user.id}:${name}`;
  }
  // 日付が違っても返す（通信できない翌日に、きのうの画面を出すため。2026-10-19）。今日の分だけ使う時は readSnapshot
  function readStoredSnapshot(user, name) {
    try {
      const raw = localStorage.getItem(snapshotKey(user, name));
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!saved || saved.v !== SNAPSHOT_VERSION || !saved.payload || typeof saved.date !== "string") return null;
      return saved;
    } catch {
      return null;
    }
  }
  function readSnapshot(user, name) {
    const saved = readStoredSnapshot(user, name);
    if (!saved || saved.date !== localDateString(Date.now())) return null;
    return saved;
  }
  function writeSnapshot(user, name, payload) {
    try {
      localStorage.setItem(snapshotKey(user, name), JSON.stringify({ v: SNAPSHOT_VERSION, date: localDateString(Date.now()), at: Date.now(), payload }));
    } catch {
      // 容量いっぱい・プライベートモード等。控えが無いだけで、画面は普通に出る
    }
  }
  function clearSnapshots() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(SNAPSHOT_PREFIX)) keys.push(key);
      }
      keys.forEach((key) => localStorage.removeItem(key));
    } catch {
      // 読めない環境では何もしない
    }
  }
  // ログイン状態の世代番号。ログイン・ログアウトのたびに増える。通信の前後で違っていたら、その結果は捨てる
  //   （通信中にログアウトした・別の人に替わった時に、遅れて返った前の人の記録を描いたり控えたりしないように。2026-10-15 第三者レビュー）
  let authGen = 0;
  // 今日の控えがあればそれを、無ければ fetcher() の結果を控えてから返す。戻り値 { payload, at }（at = 取った時刻）
  //   通信の間にログイン状態が変わっていたら null（呼ぶ側は何もしない）
  async function onceADay(user, name, fetcher) {
    const saved = readSnapshot(user, name);
    if (saved) return { payload: saved.payload, at: saved.at };
    const gen = authGen;
    const payload = await fetcher();
    if (gen !== authGen) return null;
    writeSnapshot(user, name, payload);
    return { payload, at: Date.now() };
  }
  function formatSnapshotTime(at) {
    const d = new Date(at);
    const pad2 = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${pad2(d.getMinutes())}`;
  }
  function formatSnapshotDay(date) {
    const m = Number(String(date).slice(5, 7));
    const d = Number(String(date).slice(8, 10));
    if (!m || !d) return "";
    return `${m}月${d}日`;
  }

  // 読み込み画面は、ログイン状態が分かってから閉じる。決まった秒数では待たない（2026-10-19）
  let loadingClosed = false;
  function hideLoadingScreen() {
    if (loadingClosed) return;
    loadingClosed = true;
    const loadingScreen = document.getElementById("loadingScreen");
    if (!loadingScreen) return;
    loadingScreen.classList.add("is-hidden");
    window.setTimeout(() => { loadingScreen.style.display = "none"; }, 700);
  }

  // ============================================================
  // タブ切り替え
  // ============================================================
  const views = document.querySelectorAll(".view");
  const navButtons = document.querySelectorAll(".nav-btn");
  let logDirty = true; // ログ・グラフは、どちらかのタブを開くまで描かない（2026-10-19）

  function activateTab(tab) {
    views.forEach((view) => {
      view.hidden = view.dataset.view !== tab;
    });
    // チャンネルのページはホームの続きなので、下のタブは「ホーム」を光らせたまま
    const navTab = tab === "channel" ? "home" : tab;
    navButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tab === navTab);
    });
    document.querySelector(`.view[data-view="${tab}"]`)?.scrollTo?.(0, 0);
    if (tab === "log" || tab === "graph") {
      if (logDirty) renderLogCharts();
      else solidSync();
    } else {
      solidStop();
    }
  }

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  // 見出し・ボタンの絵文字だった所（<span data-icon="…">）を SVG アイコンに置き換える（icons.js。2026-10-25 依頼者）
  window.EmoIcons.hydrateIcons();

  // ============================================================
  // ホームの 3 つの数字のアイコン（SVG。絵文字をやめ、青→紫→ピンクのグラデーションのデフォルメした形に。2026-10-14 依頼者）
  //   自前の固定の文字列なので innerHTML に入れてよい。グラデーションの id は 3 つで別にする（同じ画面に並ぶため）
  // ============================================================
  const STAT_ICON_DEFS = (id, stops) => `<defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient></defs>`;
  const statIcons = (sfx = "") => ({
    // 炎: 外側の大きな炎（青→紫→ピンク）・内側の炎（ピンク→オレンジ）・光る芯（黄→白）
    fever: `<svg viewBox="0 0 64 64" aria-hidden="true">${STAT_ICON_DEFS(`gFev1${sfx}`, [[0, "#3b4de8"], [0.5, "#9a4cf0"], [1, "#ff5fb5"]])}${STAT_ICON_DEFS(`gFev2${sfx}`, [[0, "#ff5fb5"], [1, "#ffb347"]])}
      <path fill="url(#gFev1${sfx})" d="M33 3c5 11 17 16 20 30 2 13-6 25-21 28C17 59 8 47 10 33c1-8 7-12 9-22 4 4 6 9 6 13 2-9 5-15 8-21zM13 30c-4 6-3 14 1 19-2-7 0-13-1-19zM53 28c-1 7 1 12-2 19 5-5 6-13 2-19z"/>
      <path fill="url(#gFev2${sfx})" d="M32 22c4 7 12 11 12 22 0 8-6 14-12 14s-12-6-12-14c0-6 4-9 5-15 3 3 4 6 4 9 1-6 2-11 3-16z"/>
      <circle cx="32" cy="47" r="6.5" fill="#fff0a8"/><circle cx="32" cy="47" r="3.5" fill="#ffffff"/></svg>`,
    // コメント: 吹き出し（青→紫）＋ 右上にキラッとした星
    comments: `<svg viewBox="0 0 64 64" aria-hidden="true">${STAT_ICON_DEFS(`gCom1${sfx}`, [[0, "#3b4de8"], [0.6, "#8a5cf0"], [1, "#ff7bd0"]])}
      <path fill="url(#gCom1${sfx})" d="M14 12h30a10 10 0 0 1 10 10v12a10 10 0 0 1-10 10H30l-11 10v-10h-5A10 10 0 0 1 4 34V22a10 10 0 0 1 10-10z"/>
      <circle cx="19" cy="28" r="3.2" fill="#ffffff" opacity="0.95"/><circle cx="29" cy="28" r="3.2" fill="#ffffff" opacity="0.95"/><circle cx="39" cy="28" r="3.2" fill="#ffffff" opacity="0.95"/>
      <path fill="#ffe36b" d="M52 4l2.2 5.8L60 12l-5.8 2.2L52 20l-2.2-5.8L44 12l5.8-2.2z"/></svg>`,
    // 視聴時間: 時計の輪（青→紫→ピンク）に、流れ星のような針と右上の星
    watch: `<svg viewBox="0 0 64 64" aria-hidden="true">${STAT_ICON_DEFS(`gWat1${sfx}`, [[0, "#3b4de8"], [0.55, "#9a4cf0"], [1, "#ff5fb5"]])}
      <circle cx="30" cy="34" r="22" fill="none" stroke="url(#gWat1${sfx})" stroke-width="7" stroke-linecap="round" stroke-dasharray="118 20" transform="rotate(-60 30 34)"/>
      <path fill="url(#gWat1${sfx})" d="M30 18a3 3 0 0 1 3 3v12l8 5a3 3 0 0 1-3 5l-10-6a3 3 0 0 1-1-2V21a3 3 0 0 1 3-3z"/>
      <path fill="#ffe36b" d="M51 6l2.4 6.6L60 15l-6.6 2.4L51 24l-2.4-6.6L42 15l6.6-2.4z"/></svg>`,
  });
  const STAT_ICONS = statIcons("");
  const STAT_ICONS_CH = statIcons("Ch"); // チャンネルのページ用（id を変える）

  // ============================================================
  // 🏠 ホーム描画
  // ============================================================
  function renderHome() {
    const statGrid = document.getElementById("statGrid");
    const stats = [
      { icon: STAT_ICONS.watch, value: formatMinutes(DUMMY.achievements.totalWatchMinutes), label: "累計視聴時間" },
      { icon: STAT_ICONS.comments, value: formatCount(DUMMY.achievements.totalComments), label: "コメント送信数" },
      { icon: STAT_ICONS.fever, value: `${formatCount(DUMMY.achievements.hotMomentCount)} 回`, label: "激熱経験回数" },
    ];
    statGrid.innerHTML = stats
      .map(
        (s, i) => `
      <div class="card stat-card${i === 0 ? " span-2" : ""}">
        <span class="stat-icon">${s.icon}</span>
        <span class="stat-value">${s.value}</span>
        <span class="stat-label">${s.label}</span>
      </div>`
      )
      .join("");

    const todaySummary = document.getElementById("todaySummary");
    if (DUMMY.today) {
      const t = DUMMY.today;
      todaySummary.hidden = t.watchMs <= 0 && t.commentCount <= 0 && t.feverCount <= 0;
      todaySummary.textContent =
        `本日: 視聴 ${Math.round(t.watchMs / 60000)}分・コメント ${formatCount(t.commentCount)}件・激熱 ${formatCount(t.feverCount)}回`;
    } else {
      todaySummary.hidden = true;
    }

    const { current, longest, tier } = DUMMY.streak;
    document.getElementById("streakCount").textContent = current;
    const tierBadge = document.getElementById("tierBadge");
    tierBadge.textContent = TIER_LABEL[tier];
    tierBadge.dataset.tier = tier;

    const goal = TIER_GOAL[tier];
    document.getElementById("streakSub").textContent =
      goal === Infinity
        ? `最高記録: ${longest}日連続`
        : `次のクラスまであと ${Math.max(0, goal - current)}日（最高記録 ${longest}日）`;

    const track = document.getElementById("streakTrack");
    const dotCount = 7;
    const filled = Math.min(dotCount, current);
    track.innerHTML = Array.from({ length: dotCount }, (_, i) =>
      `<span class="streak-dot${i < filled ? " is-filled" : ""}"></span>`
    ).join("");

    renderPoints();
    renderChannelList();
  }

  // 獲得ポイント実績（これまでに獲得した合計・内訳・チャンネルごと）。残高や受け取りは扱わない
  function renderPoints() {
    const { common, channels } = DUMMY.points;
    const channelSum = channels.reduce((sum, ch) => sum + ch.points, 0);
    document.getElementById("pointsTotal").textContent = formatCount(common + channelSum);
    document.getElementById("pointsCommon").textContent = `${formatCount(common)} pt`;
    document.getElementById("pointsChannelSum").textContent = `${formatCount(channelSum)} pt`;

    const list = document.getElementById("pointsChannelList");
    list.replaceChildren();
    if (channels.length === 0) {
      const empty = document.createElement("li");
      empty.className = "points-empty";
      empty.textContent = "応援ポイントは、実装準備中です。"; // 有料版の話はしない（2026-10-10 依頼者）
      list.append(empty);
      return;
    }
    [...channels].sort((a, b) => b.points - a.points).forEach((ch, i) => {
      const row = document.createElement("li");
      row.className = "points-channel-row";

      let avatar;
      if (ch.avatarUrl) {
        avatar = document.createElement("img");
        avatar.src = ch.avatarUrl;
        avatar.alt = "";
        avatar.referrerPolicy = "no-referrer";
      } else {
        avatar = document.createElement("span");
        avatar.textContent = initialOf(ch.name);
        avatar.style.background = colorFor(i);
      }
      avatar.className = "points-channel-avatar";

      const name = document.createElement("span");
      name.className = "points-channel-name";
      name.textContent = ch.name; // 配信者名は外部由来の文字列なので textContent で入れる

      const pt = document.createElement("span");
      pt.className = "points-channel-pt";
      pt.textContent = `${formatCount(ch.points)} pt`;

      row.classList.add("is-link");
      row.addEventListener("click", () => openChannel(ch, i));
      row.append(avatar, name, pt);
      list.append(row);
    });
  }

  // ============================================================
  // 📈 推し活グラフ（獲得ポイント・視聴時間・コメント数を、日別・月別・年別の棒グラフで見る）
  //   元データは user_daily_activity の日別の行（拡張機能が同期のたびに「今日の最新の合計」で上書きしている）。
  //   月別・年別は、ここで日別を合算して出す。ポイントは共通・チャンネルの種類ごとにも見られる
  // ============================================================
  const graphState = { metric: "points", period: "day", kind: "all", selected: null };
  // えもちゃテイスト（2026-10-09）: ピンクと青。前は common #ffcf33・channel #5b9bff・single #ff9a3c
  const GRAPH_COLORS = { common: "#ff8cc6", channel: "#8d9bff", single: "#ff8cc6" };
  const GRAPH_RANGE = { day: 30, month: 12, year: 5 }; // 期間ごとに何本並べるか
  const SVG_NS = "http://www.w3.org/2000/svg";
  const METRIC_LABEL = { watch: "視聴時間", comments: "コメント数", fever: "激熱の回数", points: "獲得ポイント", density: "コメント密度" };

  // 期間ごとの棒のキー（日: YYYY-MM-DD / 月: YYYY-MM / 年: YYYY）を、古い順に今日まで並べる
  function graphBuckets(period) {
    const count = GRAPH_RANGE[period];
    const now = new Date();
    const keys = [];
    for (let i = count - 1; i >= 0; i--) {
      if (period === "day") {
        keys.push(localDateString(Date.now() - i * 86_400_000));
      } else if (period === "month") {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      } else {
        keys.push(String(now.getFullYear() - i));
      }
    }
    return keys;
  }

  function graphKeyLabel(period, key) {
    if (period === "day") return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
    if (period === "month") return `${Number(key.slice(5, 7))}月`;
    return `${key}年`;
  }

  // 棒ごとの値。ポイントは共通・チャンネルの 2 つを重ねた棒（種類で絞れる）、それ以外は 1 つ
  function graphSeries() {
    const { metric, period, kind } = graphState;
    const keys = graphBuckets(period);
    const keyLen = period === "day" ? 10 : period === "month" ? 7 : 4;
    const acc = new Map(keys.map((k) => [k, { common: 0, channel: 0, value: 0 }]));
    for (const row of DUMMY.activity) {
      const bucket = acc.get(row.date.slice(0, keyLen));
      if (!bucket) continue;
      bucket.common += row.commonPoints;
      bucket.channel += row.channelPoints;
      bucket.value += metric === "watch" ? row.watchMs : metric === "fever" ? row.feverCount : row.commentCount;
    }
    return keys.map((key) => {
      const b = acc.get(key);
      const parts = metric === "points"
        ? [
          // 共通ポイントは 2026-10-06 に廃止。帯はチャンネルだけ（2026-10-17 文書の整合レビュー A）
          { id: "channel", label: "チャンネル", value: b.channel },
        ]
        : [{ id: "single", label: METRIC_LABEL[metric], value: b.value }];
      return { key, label: graphKeyLabel(period, key), parts, total: parts.reduce((sum, p) => sum + p.value, 0) };
    });
  }

  function graphFormat(metric, value) {
    if (metric === "points") return `${formatCount(Math.round(value))} pt`;
    if (metric === "watch") return formatWatchDuration(value);
    if (metric === "fever") return `${formatCount(Math.round(value))} 回`;
    if (metric === "density") return `${value.toFixed(1)} 件/時`;
    return `${formatCount(Math.round(value))} 件`;
  }

  // 縦軸の上端は「きりのよい数」に丸める（最大値の約 1.1 倍以上で、1・2・5・10 の倍数）
  function niceMax(max) {
    if (max <= 0) return 4;
    const raw = max * 1.1;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }

  function graphAxisLabel(metric, v) {
    if (metric === "watch") {
      const minutes = v / 60_000;
      return minutes >= 120 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes)}m`;
    }
    return v >= 10_000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
  }

  function svgEl(name, attrs = {}) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function renderGraph() {
    const { metric, period } = graphState;
    const series = graphSeries();
    document.getElementById("graphKind").hidden = true; // ポイントの種類はチャンネルだけになったので、切り替えは出さない（2026-10-17）

    const total = series.reduce((sum, b) => sum + b.total, 0);
    const periodLabel = { day: "直近30日", month: "直近12か月", year: "直近5年" }[period];
    const summary = document.getElementById("graphSummary");
    summary.textContent = graphFormat(metric, total);
    const small = document.createElement("small");
    small.textContent = `${periodLabel}の合計`;
    summary.append(small);

    const svg = document.getElementById("graphSvg");
    svg.replaceChildren();
    const W = 320, H = 170, left = 30, right = 6, top = 8, bottom = 22;
    const plotW = W - left - right, plotH = H - top - bottom;
    const max = niceMax(Math.max(...series.map((b) => b.total)));

    for (let i = 0; i <= 4; i++) {
      const y = top + plotH - (plotH * i) / 4;
      svg.append(svgEl("line", { class: "g-grid", x1: left, x2: W - right, y1: y, y2: y }));
      const label = svgEl("text", { class: "g-label", x: left - 4, y: y + 3, "text-anchor": "end" });
      label.textContent = graphAxisLabel(metric, (max * i) / 4);
      svg.append(label);
    }

    const slot = plotW / series.length;
    const barW = Math.max(2, Math.min(24, slot * 0.7));
    const labelEvery = Math.ceil(series.length / 6); // 横軸のラベルは混み合わないよう間引く
    series.forEach((b, i) => {
      const x = left + slot * i + (slot - barW) / 2;
      let yCursor = top + plotH;
      for (const part of b.parts) {
        const h = (part.value / max) * plotH;
        if (h <= 0) continue;
        yCursor -= h;
        svg.append(svgEl("rect", {
          class: `g-bar${graphState.selected === b.key ? " is-selected" : ""}`,
          x, y: yCursor, width: barW, height: h, rx: Math.min(3, barW / 3), fill: GRAPH_COLORS[part.id],
        }));
      }
      if (i % labelEvery === 0 || i === series.length - 1) {
        const t = svgEl("text", { class: "g-label", x: x + barW / 2, y: H - 7, "text-anchor": "middle" });
        t.textContent = b.label;
        svg.append(t);
      }
      // 細い棒でもタップしやすいよう、1 本ぶんの縦帯全体を押せる透明な当たり判定を重ねる
      const hit = svgEl("rect", { class: "g-hit", x: left + slot * i, y: top, width: slot, height: plotH });
      hit.addEventListener("click", () => {
        graphState.selected = b.key;
        renderGraph();
      });
      svg.append(hit);
    });
    fitGraphSvg(svg, series.length, plotW);

    const legend = document.getElementById("graphLegend");
    legend.replaceChildren();
    const legendParts = metric === "points"
      ? [["channel", "チャンネルポイント"]] // 共通ポイントは廃止（2026-10-17）
      : [["single", METRIC_LABEL[metric]]];
    for (const [id, text] of legendParts) {
      const item = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = GRAPH_COLORS[id];
      item.append(dot, text);
      legend.append(item);
    }

    const detail = document.getElementById("graphDetail");
    const picked = series.find((b) => b.key === graphState.selected);
    if (picked) {
      const parts = metric === "points" && picked.parts.length > 1
        ? `（${picked.parts.map((p) => `${p.label} ${formatCount(p.value)}`).join(" / ")}）`
        : "";
      detail.textContent = `${picked.label}: ${graphFormat(metric, picked.total)}${parts}`;
    } else {
      detail.textContent = "棒をタップすると内訳が見られます";
    }

    renderWeekday();

    document.getElementById("graphNote").textContent = metric === "points"
      ? "獲得ポイントの日別記録は、拡張機能を更新して同期した日から貯まります（それ以前の分はグラフに出ません）。"
      : "";
  }

  // 曜日ごとの傾向（全期間の日別記録から、曜日ごとの 1 日あたりの平均）。項目・ポイントの種類は上のグラフに合わせる
  function renderWeekday() {
    const { metric, kind } = graphState;
    const sums = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
    for (const row of DUMMY.activity) {
      const wd = new Date(`${row.date}T00:00:00`).getDay();
      const v = metric === "points"
        ? (kind === "common" ? row.commonPoints : kind === "channel" ? row.channelPoints : row.commonPoints + row.channelPoints)
        : metric === "watch" ? row.watchMs : metric === "fever" ? row.feverCount : row.commentCount;
      sums[wd].total += v;
      sums[wd].days += 1;
    }
    const order = [1, 2, 3, 4, 5, 6, 0];
    const names = ["日", "月", "火", "水", "木", "金", "土"];
    const avgs = order.map((wd) => (sums[wd].days ? sums[wd].total / sums[wd].days : 0));
    const max = Math.max(...avgs, 0);
    const box = document.getElementById("weekdayChart");
    box.replaceChildren();
    order.forEach((wd, i) => {
      const col = document.createElement("div");
      col.className = `wk-col${max > 0 && avgs[i] === max ? " is-top" : ""}`;
      const val = document.createElement("span");
      val.className = "wk-val";
      val.textContent = avgs[i] <= 0 ? "" : (metric === "fever" || metric === "comments") && avgs[i] < 10 ? avgs[i].toFixed(1) : graphAxisLabel(metric, avgs[i]);
      const bar = document.createElement("div");
      bar.className = "wk-bar";
      bar.style.height = `${max > 0 ? Math.max(3, (avgs[i] / max) * 80) : 3}px`;
      const day = document.createElement("span");
      day.className = "wk-day";
      day.textContent = names[wd];
      col.append(val, bar, day);
      box.append(col);
    });
  }

  // チャンネル別の内訳（上位 8 件までを横棒で。累計の値）
  const bdState = { metric: "watch" };
  function renderBreakdown() {
    const { metric } = bdState;
    // 密度は「視聴1時間あたりのコメント数」。視聴が短いと大きくぶれるので、30分以上見たチャンネルだけ
    const density = (c) => (c.watchMs >= 30 * 60_000 ? c.comments / (c.watchMs / 3_600_000) : 0);
    const pick = (c) => (metric === "watch" ? c.watchMs : metric === "comments" ? c.comments : metric === "fever" ? c.fever : metric === "density" ? density(c) : c.points);
    const rows = DUMMY.channels.filter((c) => pick(c) > 0).sort((a, b) => pick(b) - pick(a)).slice(0, 8);
    const list = document.getElementById("bdList");
    list.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "points-empty";
      empty.textContent = "まだデータがありません。";
      list.append(empty);
    }
    const max = rows.length ? pick(rows[0]) : 0;
    for (const c of rows) {
      const row = document.createElement("div");
      row.className = "bd-row";
      const name = document.createElement("span");
      name.className = "bd-name";
      name.textContent = c.name; // 配信者名は外部由来の文字列なので textContent で入れる
      const track = document.createElement("div");
      track.className = "bd-track";
      const fill = document.createElement("div");
      fill.className = "bd-fill";
      fill.style.width = `${Math.max(3, (pick(c) / max) * 100)}%`;
      track.append(fill);
      const val = document.createElement("span");
      val.className = "bd-val";
      val.textContent = graphFormat(metric, pick(c));
      row.append(name, track, val);
      list.append(row);
    }

    // ライブとアーカイブ（視聴時間の割合。全チャンネル合計）
    const watch = DUMMY.channels.reduce((sum, c) => sum + c.watchMs, 0);
    const live = Math.min(watch, DUMMY.channels.reduce((sum, c) => sum + c.liveWatchMs, 0));
    renderDonut(document.getElementById("liveDonut"), document.getElementById("liveDonutLegend"), [
      { label: "ライブ", value: live, color: GRAPH_COLORS.common },
      { label: "アーカイブ", value: watch - live, color: GRAPH_COLORS.channel },
    ], formatWatchDuration(watch));
  }

  function renderDonut(svg, legend, parts, centerText) {
    svg.replaceChildren();
    legend.replaceChildren();
    const total = parts.reduce((sum, p) => sum + p.value, 0);
    const r = 36, C = 2 * Math.PI * r;
    svg.append(svgEl("circle", { cx: 50, cy: 50, r, fill: "none", stroke: "rgba(128,128,128,0.2)", "stroke-width": 14 }));
    let offset = 0;
    for (const p of parts) {
      if (total <= 0 || p.value <= 0) continue;
      const len = (p.value / total) * C;
      svg.append(svgEl("circle", {
        cx: 50, cy: 50, r, fill: "none", stroke: p.color, "stroke-width": 14,
        "stroke-dasharray": `${len} ${C - len}`, "stroke-dashoffset": -offset, transform: "rotate(-90 50 50)",
      }));
      offset += len;
    }
    const t = svgEl("text", { class: "d-center", x: 50, y: 52, "text-anchor": "middle" });
    t.textContent = centerText;
    svg.append(t);
    for (const p of parts) {
      const item = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = p.color;
      const pct = document.createElement("b");
      pct.textContent = total > 0 ? `${Math.round((p.value / total) * 100)}%` : "-";
      item.append(dot, p.label, pct);
      legend.append(item);
    }
  }

  // 狭い幅では、棒が多い時だけ横に送って 1 本を太くする（2026-10-19）
  function fitGraphSvg(svg, seriesLength, plotW) {
    const narrow = window.matchMedia("(max-width: 380px)").matches;
    if (!narrow || seriesLength <= 0) {
      svg.style.width = "";
      return;
    }
    const cssW = Math.ceil(32 * 320 / (plotW / seriesLength));
    svg.style.width = cssW > 360 ? `${cssW}px` : "";
  }

  function setupGraph() {
    document.getElementById("bdMetric").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      bdState.metric = btn.dataset.value;
      document.querySelectorAll("#bdMetric .seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      renderBreakdown();
    });
    for (const [id, key] of [["graphMetric", "metric"], ["graphPeriod", "period"], ["graphKind", "kind"]]) {
      document.getElementById(id).addEventListener("click", (e) => {
        const btn = e.target.closest(".seg-btn");
        if (!btn) return;
        graphState[key] = btn.dataset.value;
        graphState.selected = null;
        document.querySelectorAll(`#${id} .seg-btn`).forEach((b) => b.classList.toggle("is-active", b === btn));
        renderGraph();
      });
    }
  }

  // ============================================================
  // 🎨 見て楽しいグラフ（ハニカム・花びら・ブロック・バブル・成長曲線・レーダー）
  //   上の「推し活グラフ」「チャンネル別の内訳」と同じデータを、別の見た目で眺めるためのカード。
  //   ハニカム・花びら・成長曲線・レーダーは日別の記録（DUMMY.activity）、ブロック・バブルはチャンネル別の累計（DUMMY.channels）から描く
  // ============================================================
  const vizState = { type: "honey", metric: "watch" };
  // えもちゃテイスト（2026-10-09）: ピンク・青・すみれを先頭に。上に濃い文字（.v-label-on）を載せるので、どれも明るめの色にする
  const VIZ_PALETTE = ["#ff8cc6", "#9aa8ff", "#c4a6ff", "#ffcf6b", "#6fdcc8", "#ffa27a", "#7fb4ff", "#e79ae6"];
  const HONEY_COLORS = ["rgba(128,128,160,0.18)", "#3f2a78", "#6f45c2", "#c06ce6", "#ff8cc6"]; // すみれ → ピンク（前は金の濃淡）
  let vizSel = null;

  function vizDayValue(row, metric) {
    if (metric === "points") return row.commonPoints + row.channelPoints;
    if (metric === "watch") return row.watchMs;
    return metric === "fever" ? row.feverCount : row.commentCount;
  }

  function vizChannelValue(c, metric) {
    if (metric === "watch") return c.watchMs;
    if (metric === "comments") return c.comments;
    return metric === "fever" ? c.fever : c.points;
  }

  // 図の一部をタップした時: 選んだ印を付け替えて、下の説明の文を変える
  function vizPick(el, text) {
    vizSel?.classList.remove("is-selected");
    vizSel = el;
    el.classList.add("is-selected");
    document.getElementById("vizDetail").textContent = text;
  }

  function vizLabel(parent, text, attrs) {
    const t = svgEl("text", { class: "v-label", ...attrs });
    t.textContent = text;
    parent.append(t);
    return t;
  }

  function shortName(name, max) {
    const chars = [...name];
    return chars.length > max ? `${chars.slice(0, max).join("")}…` : name;
  }

  // 蜂の巣（ハニカム）: 直近 100 日を、六角形のマスにして敷き詰める。明るいピンクほど多い日（2026-10-09 までは黄色）
  function drawHoney(svg) {
    const { metric } = vizState;
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const cols = 10, rows = 10, r = 14.5;
    const w = Math.sqrt(3) * r;
    const rowH = 1.5 * r;
    const offsetX = (320 - (cols * w + w / 2)) / 2;
    const cells = [];
    for (let i = rows * cols - 1; i >= 0; i--) {
      const date = localDateString(Date.now() - i * 86_400_000);
      const row = byDate.get(date);
      cells.push({ date, value: row ? vizDayValue(row, metric) : 0 });
    }
    const max = Math.max(...cells.map((c) => c.value), 0);
    svg.setAttribute("viewBox", "0 0 320 250");
    cells.forEach((c, idx) => {
      const rr = Math.floor(idx / cols);
      const cc = idx % cols;
      const cx = offsetX + w / 2 + cc * w + (rr % 2 ? w / 2 : 0);
      const cy = r + 6 + rr * rowH;
      const pts = Array.from({ length: 6 }, (_, k) => {
        const a = (Math.PI / 180) * (60 * k - 30);
        return `${(cx + (r - 1.5) * Math.cos(a)).toFixed(1)},${(cy + (r - 1.5) * Math.sin(a)).toFixed(1)}`;
      }).join(" ");
      const level = max <= 0 || c.value <= 0 ? 0 : Math.min(4, Math.ceil((c.value / max) * 4));
      const hex = svgEl("polygon", { points: pts, class: `v-shape${idx === cells.length - 1 ? " is-today" : ""}`, fill: HONEY_COLORS[level] });
      hex.addEventListener("click", () => vizPick(hex, `${c.date}: ${graphFormat(metric, c.value)}`));
      svg.append(hex);
    });
    return "直近100日。ピンクが明るいほど、多かった日です（いちばん右下が今日）。";
  }

  // 花びら（ローズチャート）: 直近 12 か月を 12 枚の花びらにして、多い月ほど長く伸ばす
  function drawRose(svg) {
    const { metric } = vizState;
    const keys = graphBuckets("month");
    const sums = new Map(keys.map((k) => [k, 0]));
    for (const row of DUMMY.activity) {
      const k = row.date.slice(0, 7);
      if (sums.has(k)) sums.set(k, sums.get(k) + vizDayValue(row, metric));
    }
    const max = Math.max(...sums.values(), 0);
    const cx = 160, cy = 130, R = 104, r0 = 16;
    const pt = (rad, deg) => `${(cx + rad * Math.cos((deg * Math.PI) / 180)).toFixed(1)} ${(cy + rad * Math.sin((deg * Math.PI) / 180)).toFixed(1)}`;
    svg.setAttribute("viewBox", "0 0 320 260");
    svg.append(svgEl("circle", { cx, cy, r: R, fill: "none", stroke: "rgba(128,128,128,0.18)", "stroke-dasharray": "2 4" }));
    keys.forEach((key, i) => {
      const v = sums.get(key);
      const a0 = -90 + i * 30 + 1.5;
      const a1 = a0 + 27;
      const rad = r0 + (R - r0) * Math.sqrt(max > 0 ? v / max : 0); // 面積が値に比例するよう平方根で伸ばす
      const d = `M ${pt(r0, a0)} L ${pt(rad, a0)} A ${rad} ${rad} 0 0 1 ${pt(rad, a1)} L ${pt(r0, a1)} A ${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z`;
      const petal = svgEl("path", { d, class: "v-shape", fill: `hsl(${(i * 28 + 20) % 360} 85% 62%)`, "fill-opacity": 0.92 });
      petal.addEventListener("click", () => vizPick(petal, `${graphKeyLabel("month", key)}: ${graphFormat(metric, v)}`));
      svg.append(petal);
      const mid = a0 + 13.5;
      const [lx, ly] = pt(R + 12, mid).split(" ");
      vizLabel(svg, graphKeyLabel("month", key), { x: lx, y: Number(ly) + 3, "text-anchor": "middle" });
    });
    return "直近12か月。花びらが長い月ほど、たくさんあった月です。";
  }

  // ブロック（ツリーマップ）: チャンネルごとの大きさを、面積で比べる
  function treemapLayout(items, x, y, w, h, out) {
    if (items.length === 0) return;
    if (items.length === 1) {
      out.push({ item: items[0], x, y, w, h });
      return;
    }
    const total = items.reduce((s, i) => s + i.value, 0);
    let acc = 0;
    let k = 0;
    while (k < items.length - 1 && acc + items[k].value / 2 < total / 2) {
      acc += items[k].value;
      k++;
    }
    k = Math.max(1, k);
    const a = items.slice(0, k);
    const b = items.slice(k);
    const ratio = a.reduce((s, i) => s + i.value, 0) / total;
    if (w >= h) {
      treemapLayout(a, x, y, w * ratio, h, out);
      treemapLayout(b, x + w * ratio, y, w * (1 - ratio), h, out);
    } else {
      treemapLayout(a, x, y, w, h * ratio, out);
      treemapLayout(b, x, y + h * ratio, w, h * (1 - ratio), out);
    }
  }

  function drawTree(svg) {
    const { metric } = vizState;
    const items = DUMMY.channels
      .map((c) => ({ name: c.name, value: vizChannelValue(c, metric) }))
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);
    svg.setAttribute("viewBox", "0 0 320 250");
    if (items.length === 0) return "まだデータがありません。";
    const rects = [];
    treemapLayout(items, 4, 4, 312, 242, rects);
    rects.forEach(({ item, x, y, w, h }, i) => {
      const g = svgEl("g");
      const rect = svgEl("rect", {
        class: "v-shape", x: x + 1.5, y: y + 1.5, width: Math.max(0, w - 3), height: Math.max(0, h - 3), rx: 8,
        fill: VIZ_PALETTE[i % VIZ_PALETTE.length], "fill-opacity": 0.85,
      });
      rect.addEventListener("click", () => vizPick(rect, `${item.name}: ${graphFormat(metric, item.value)}`));
      g.append(rect);
      // 小さいブロックは、はみ出さないよう名前だけ（値は広いブロックだけ。タップすれば値は見られる）
      if (w > 44 && h > 24) {
        vizLabel(g, shortName(item.name, Math.max(2, Math.floor((w - 12) / 12))), { class: "v-label v-label-on", x: x + 8, y: y + 18 });
      }
      if (w > 84 && h > 38) {
        vizLabel(g, graphFormat(metric, item.value), { class: "v-label v-label-on v-label-sub", x: x + 8, y: y + 32 });
      }
      svg.append(g);
    });
    return "チャンネルごとの大きさ（上位12件）。広いブロックほど、たくさんあるチャンネルです。";
  }

  // バブル: 横=視聴時間・縦=コメント数・大きさ=獲得ポイント（ポイントが無ければ激熱の回数）
  function drawBubble(svg) {
    const list = DUMMY.channels.filter((c) => c.watchMs > 0 || c.comments > 0);
    svg.setAttribute("viewBox", "0 0 320 250");
    if (list.length === 0) return "まだデータがありません。";
    const left = 34, right = 300, top = 14, bottom = 214;
    const maxX = Math.max(...list.map((c) => c.watchMs), 1);
    const maxY = Math.max(...list.map((c) => c.comments), 1);
    const size = (c) => (list.some((x) => x.points > 0) ? c.points : c.fever);
    const maxS = Math.max(...list.map(size), 1);
    svg.append(svgEl("line", { class: "g-grid", x1: left, x2: right, y1: bottom, y2: bottom }));
    svg.append(svgEl("line", { class: "g-grid", x1: left, x2: left, y1: top, y2: bottom }));
    vizLabel(svg, "視聴時間 →", { x: right, y: bottom + 16, "text-anchor": "end" });
    vizLabel(svg, "↑ コメント数", { x: left - 24, y: top - 2 });
    [...list].sort((a, b) => size(b) - size(a)).forEach((c, i) => {
      const r = 8 + Math.sqrt(size(c) / maxS) * 22;
      const cx = left + r + (c.watchMs / maxX) * (right - left - r * 2);
      const cy = bottom - r - (c.comments / maxY) * (bottom - top - r * 2);
      const bubble = svgEl("circle", { class: "v-shape", cx, cy, r, fill: VIZ_PALETTE[i % VIZ_PALETTE.length], "fill-opacity": 0.7 });
      bubble.addEventListener("click", () => vizPick(
        bubble,
        `${c.name}: 視聴 ${formatWatchDuration(c.watchMs)} / コメント ${formatCount(c.comments)} 件 / ポイント ${formatCount(c.points)} pt / 激熱 ${formatCount(c.fever)} 回`,
      ));
      svg.append(bubble);
      vizLabel(svg, shortName(c.name, 7), { x: cx, y: cy - r - 3, "text-anchor": "middle" });
    });
    return "横は視聴時間、縦はコメント数、丸の大きさは獲得ポイントです（ポイントがなければ激熱の回数）。右上に行くほど、よく見てよく書いているチャンネルです。";
  }

  // 成長曲線: 記録を始めてからの累計の伸び方（日別の記録を足し上げた線）
  function drawGrowth(svg) {
    const { metric } = vizState;
    const rows = [...DUMMY.activity].sort((a, b) => (a.date < b.date ? -1 : 1));
    svg.setAttribute("viewBox", "0 0 320 230");
    if (rows.length === 0) return "まだデータがありません。";
    let sum = 0;
    const all = rows.map((r) => ({ date: r.date, total: (sum += vizDayValue(r, metric)) }));
    const step = Math.max(1, Math.ceil(all.length / 120)); // 点が多すぎる時は間引く（最後の点は必ず残す）
    const pts = all.filter((_, i) => i % step === 0 || i === all.length - 1);
    const left = 34, right = 312, top = 10, bottom = 196;
    const max = niceMax(sum);
    const xOf = (i) => left + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (right - left));
    const yOf = (v) => bottom - (v / max) * (bottom - top);

    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: "growthFill", x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(svgEl("stop", { offset: "0%", "stop-color": "#ff8cc6", "stop-opacity": 0.5 }));
    grad.append(svgEl("stop", { offset: "100%", "stop-color": "#8b5cf6", "stop-opacity": 0 }));
    defs.append(grad);
    svg.append(defs);
    for (let i = 0; i <= 3; i++) {
      const y = bottom - ((bottom - top) * i) / 3;
      svg.append(svgEl("line", { class: "g-grid", x1: left, x2: right, y1: y, y2: y }));
      vizLabel(svg, graphAxisLabel(metric, (max * i) / 3), { x: left - 4, y: y + 3, "text-anchor": "end" });
    }
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(p.total).toFixed(1)}`).join(" ");
    svg.append(svgEl("path", { d: `${line} L ${xOf(pts.length - 1)} ${bottom} L ${xOf(0)} ${bottom} Z`, fill: "url(#growthFill)" }));
    svg.append(svgEl("path", { d: line, fill: "none", stroke: "#ff8cc6", "stroke-width": 2, "stroke-linejoin": "round" }));
    const last = pts[pts.length - 1];
    svg.append(svgEl("circle", { cx: xOf(pts.length - 1), cy: yOf(last.total), r: 3.5, fill: "#fff" }));
    [0, Math.floor((pts.length - 1) / 2), pts.length - 1].forEach((i, n) => {
      vizLabel(svg, `${Number(pts[i].date.slice(5, 7))}/${Number(pts[i].date.slice(8, 10))}`, {
        x: xOf(i), y: bottom + 16, "text-anchor": n === 0 ? "start" : n === 2 ? "end" : "middle",
      });
    });
    // 線のどこでも押せるよう、全体に透明な当たり判定を重ね、いちばん近い日を選ぶ
    const hit = svgEl("rect", { class: "g-hit", x: left, y: top, width: right - left, height: bottom - top });
    const marker = svgEl("circle", { r: 4, fill: "#fff", stroke: "#f0539b", "stroke-width": 2, visibility: "hidden" });
    hit.addEventListener("click", (e) => {
      const box = svg.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * 320;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - left) / (right - left)) * (pts.length - 1))));
      marker.setAttribute("cx", xOf(i));
      marker.setAttribute("cy", yOf(pts[i].total));
      marker.setAttribute("visibility", "visible");
      document.getElementById("vizDetail").textContent = `${pts[i].date} までの累計: ${graphFormat(metric, pts[i].total)}`;
    });
    svg.append(hit, marker);
    return `記録を始めてからの累計（合計 ${graphFormat(metric, sum)}）。線が急なほど、よく伸びた時期です。`;
  }

  // レーダー: 曜日ごとの 1 日あたりの平均を、7 角形の星のように並べる
  function drawRadar(svg) {
    const { metric } = vizState;
    const sums = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
    for (const row of DUMMY.activity) {
      const wd = new Date(`${row.date}T00:00:00`).getDay();
      sums[wd].total += vizDayValue(row, metric);
      sums[wd].days += 1;
    }
    const order = [1, 2, 3, 4, 5, 6, 0];
    const names = ["日", "月", "火", "水", "木", "金", "土"];
    const avgs = order.map((wd) => (sums[wd].days ? sums[wd].total / sums[wd].days : 0));
    const max = Math.max(...avgs, 0);
    const cx = 160, cy = 128, R = 92;
    const at = (i, frac) => {
      const a = ((-90 + (360 / 7) * i) * Math.PI) / 180;
      return [cx + R * frac * Math.cos(a), cy + R * frac * Math.sin(a)];
    };
    svg.setAttribute("viewBox", "0 0 320 250");
    for (const ring of [1 / 3, 2 / 3, 1]) {
      svg.append(svgEl("polygon", {
        points: order.map((_, i) => at(i, ring).map((n) => n.toFixed(1)).join(",")).join(" "),
        fill: "none", stroke: "rgba(128,128,128,0.25)",
      }));
    }
    order.forEach((_, i) => {
      const [x, y] = at(i, 1);
      svg.append(svgEl("line", { class: "g-grid", x1: cx, y1: cy, x2: x, y2: y }));
    });
    const poly = svgEl("polygon", {
      points: avgs.map((v, i) => at(i, max > 0 ? v / max : 0).map((n) => n.toFixed(1)).join(",")).join(" "),
      fill: "rgba(255,140,198,0.32)", stroke: "#ff8cc6", "stroke-width": 2, "stroke-linejoin": "round",
    });
    svg.append(poly);
    order.forEach((wd, i) => {
      const [x, y] = at(i, max > 0 ? avgs[i] / max : 0);
      const dot = svgEl("circle", { class: "v-shape", cx: x, cy: y, r: 5, fill: "#ff8cc6" });
      dot.addEventListener("click", () => vizPick(dot, `${names[wd]}曜日: 1日あたり ${graphFormat(metric, avgs[i])}`));
      svg.append(dot);
      const [lx, ly] = at(i, 1.18);
      vizLabel(svg, names[wd], { class: "v-label v-label-day", x: lx, y: ly + 4, "text-anchor": "middle" });
    });
    return "曜日ごとの1日あたりの平均。外側に張り出している曜日ほど、よく動いている曜日です。";
  }

  // ---- もっといろいろなグラフ（達成リング・年輪・ストリーム・ポイントの流れ・ミニ推移） ----
  const VIZ_LANES = [
    { key: "watch", name: "視聴時間", color: "#62e7ff" },
    { key: "comments", name: "コメント", color: "#8378ff" },
    { key: "fever", name: "激熱", color: "#ff6cb8" },
  ];

  // 月ごとの合計（YYYY-MM → 値）。直近 12 か月ぶん
  function vizMonthSums(metric) {
    const keys = graphBuckets("month");
    const sums = new Map(keys.map((k) => [k, 0]));
    for (const row of DUMMY.activity) {
      const k = row.date.slice(0, 7);
      if (sums.has(k)) sums.set(k, sums.get(k) + vizDayValue(row, metric));
    }
    return { keys, sums };
  }

  // 達成リング: 今月の「ここまで」が、過去 12 か月でいちばん多かった月の何割まで来たかを、3 重の輪で見せる（アクティビティリングの形）
  function drawRings(svg) {
    svg.setAttribute("viewBox", "0 0 320 330");
    const cx = 160, cy = 112;
    const thisKey = graphBuckets("month").pop();
    const radii = [88, 66, 44];
    VIZ_LANES.forEach((lane, i) => {
      const { keys, sums } = vizMonthSums(lane.key);
      const best = Math.max(...keys.map((k) => sums.get(k)), 0);
      const cur = sums.get(thisKey);
      const ratio = best > 0 ? Math.min(1, cur / best) : 0;
      const r = radii[i];
      const C = 2 * Math.PI * r;
      svg.append(svgEl("circle", { cx, cy, r, fill: "none", stroke: lane.color, "stroke-opacity": 0.16, "stroke-width": 16 }));
      const arc = svgEl("circle", {
        class: "v-shape", cx, cy, r, fill: "none", stroke: lane.color, "stroke-width": 16, "stroke-linecap": "round",
        "stroke-dasharray": `${Math.max(0.01, C * ratio)} ${C}`, transform: `rotate(-90 ${cx} ${cy})`,
      });
      arc.addEventListener("click", () => vizPick(arc, `${lane.name}: 今月 ${graphFormat(lane.key, cur)}（最高の月 ${graphFormat(lane.key, best)} の ${Math.round(ratio * 100)}%）`));
      svg.append(arc);
      // 凡例
      const y = 238 + i * 28;
      svg.append(svgEl("circle", { cx: 40, cy: y - 4, r: 5, fill: lane.color }));
      vizLabel(svg, lane.name, { class: "v-label v-label-day", x: 52, y });
      vizLabel(svg, `${graphFormat(lane.key, cur)}（最高の月の ${Math.round(ratio * 100)}%）`, { x: 280, y, "text-anchor": "end" });
    });
    return "今月ここまでの量が、過去12か月でいちばん多かった月の何%まで来たかです。外側から 視聴時間・コメント・激熱。1周すると、最高の月に並びます。";
  }

  // 年輪（放射状カレンダー）: 内側が古い月、外側が今月。1 周が 1 か月で、時計回りに 1 日から 31 日
  function drawYear(svg) {
    const { metric } = vizState;
    svg.setAttribute("viewBox", "0 0 320 250");
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const keys = graphBuckets("month");
    const todayStr = localDateString(Date.now());
    const cx = 160, cy = 125, r0 = 22, th = 7.4, step = 8.4;
    const all = [];
    const cells = keys.map((key) => {
      const [y, m] = key.split("-").map(Number);
      const days = new Date(y, m, 0).getDate();
      return Array.from({ length: days }, (_, d) => {
        const date = `${key}-${String(d + 1).padStart(2, "0")}`;
        const row = byDate.get(date);
        const value = date > todayStr ? -1 : row ? vizDayValue(row, metric) : 0;
        all.push(value);
        return { date, value };
      });
    });
    const max = Math.max(...all, 0);
    const pt = (rad, deg) => `${(cx + rad * Math.cos((deg * Math.PI) / 180)).toFixed(1)} ${(cy + rad * Math.sin((deg * Math.PI) / 180)).toFixed(1)}`;
    cells.forEach((month, mi) => {
      const rin = r0 + mi * step, rout = rin + th;
      month.forEach((c, di) => {
        const a0 = -90 + (di * 360) / 31 + 0.5, a1 = -90 + ((di + 1) * 360) / 31 - 0.5;
        const d = `M ${pt(rin, a0)} L ${pt(rout, a0)} A ${rout} ${rout} 0 0 1 ${pt(rout, a1)} L ${pt(rin, a1)} A ${rin} ${rin} 0 0 0 ${pt(rin, a0)} Z`;
        const fill = c.value < 0 ? "rgba(128,128,160,0.07)" : c.value === 0 ? "rgba(128,128,160,0.2)" : `rgb(${solidGold(max > 0 ? c.value / max : 0).join(",")})`;
        const cell = svgEl("path", { d, class: c.value < 0 ? "" : "v-shape", fill });
        if (c.value >= 0) cell.addEventListener("click", () => vizPick(cell, `${c.date}: ${graphFormat(metric, c.value)}`));
        svg.append(cell);
      });
    });
    // 月のラベル: 12 時の位置（1 日の始まり）に、内側から月名を小さく並べる
    keys.forEach((key, mi) => vizLabel(svg, `${Number(key.slice(5, 7))}月`, { x: cx + 2, y: cy - (r0 + mi * step + th / 2) + 2.5, class: "v-label v-label-tiny" }));
    return "年輪のカレンダー。内側が古い月、外側が今月で、時計回りに1日から31日です。明るい色の日ほど、多かった日です。";
  }

  // 点の並びをなめらかにつなぐ曲線（中点どうしを 2 次ベジェでつなぐ）
  function smoothPath(pts, move = true) {
    let d = `${move ? "M" : "L"} ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    return `${d} L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  }

  // ストリーム: 直近 13 週の 視聴時間・コメント・激熱 を、川の流れのように重ねて、太さの移り変わりを見る（各項目は自分の最大に合わせた太さ）
  function drawStream(svg) {
    svg.setAttribute("viewBox", "0 0 320 250");
    const weeks = 13;
    const now = Date.now();
    const buckets = Array.from({ length: weeks }, () => ({ watch: 0, comments: 0, fever: 0 }));
    for (const row of DUMMY.activity) {
      const age = Math.floor((now - new Date(`${row.date}T00:00:00`).getTime()) / 86_400_000);
      if (age < 0 || age >= weeks * 7) continue;
      const b = buckets[weeks - 1 - Math.floor(age / 7)];
      b.watch += row.watchMs;
      b.comments += row.commentCount;
      b.fever += row.feverCount;
    }
    const maxOf = Object.fromEntries(VIZ_LANES.map((l) => [l.key, Math.max(...buckets.map((b) => b[l.key]), 0)]));
    const norm = buckets.map((b) => VIZ_LANES.map((l) => (maxOf[l.key] > 0 ? b[l.key] / maxOf[l.key] : 0)));
    const maxTotal = Math.max(...norm.map((v) => v.reduce((s, x) => s + x, 0)), 0.01);
    const left = 14, right = 306, midY = 108, half = 88;
    const xOf = (i) => left + (i / (weeks - 1)) * (right - left);
    const scale = (half * 2) / maxTotal;
    // 川の中心を一定にして、上下に広げる（全体の太さが増えても、中心線は動かない）
    const layers = VIZ_LANES.map(() => ({ top: [], bottom: [] }));
    norm.forEach((vals, i) => {
      const total = vals.reduce((s, x) => s + x, 0);
      let y = midY - (total * scale) / 2;
      vals.forEach((v, k) => {
        layers[k].top.push([xOf(i), y]);
        y += v * scale;
        layers[k].bottom.push([xOf(i), y]);
      });
    });
    VIZ_LANES.forEach((lane, k) => {
      const d = `${smoothPath(layers[k].top)} ${smoothPath([...layers[k].bottom].reverse(), false)} Z`;
      const layer = svgEl("path", { d, class: "v-shape", fill: lane.color, "fill-opacity": 0.82 });
      layer.addEventListener("click", () => {
        const total = buckets.reduce((s, b) => s + b[lane.key], 0);
        vizPick(layer, `${lane.name}: 13週間で ${graphFormat(lane.key, total)}`);
      });
      svg.append(layer);
    });
    [0, Math.floor((weeks - 1) / 2), weeks - 1].forEach((i, n) => {
      const d = new Date(now - (weeks - 1 - i) * 7 * 86_400_000);
      vizLabel(svg, `${d.getMonth() + 1}/${d.getDate()}`, { x: xOf(i), y: 214, "text-anchor": n === 0 ? "start" : n === 2 ? "end" : "middle" });
    });
    VIZ_LANES.forEach((lane, k) => {
      svg.append(svgEl("circle", { cx: 40 + k * 90, cy: 236, r: 5, fill: lane.color }));
      vizLabel(svg, lane.name, { x: 50 + k * 90, y: 240 });
    });
    return "直近13週間の流れ。川が太い週ほど、たくさんあった週です。3つの項目は、それぞれ自分の最大に合わせた太さです。";
  }

  // ポイントの流れ（サンキー）: 貯めたポイントが、使った分と残りに分かれていく様子（左: 貯めた元、右: 使った / 残り）
  function drawSankey(svg) {
    svg.setAttribute("viewBox", "0 0 320 250");
    const { common, commonSpent, channels } = DUMMY.points;
    const sources = []; // 共通ポイントは廃止（常に 0）。貯めた元はチャンネルだけ（2026-10-17）
    DUMMY.channels
      .filter((c) => c.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 5)
      .forEach((c, i) => sources.push({ name: shortName(c.name, 5), earned: c.points, spent: Math.min(c.spent, c.points), color: hslToCss(200 + i * 34) }));
    const total = sources.reduce((s, x) => s + x.earned, 0);
    if (total <= 0) return "まだポイントがありません。";
    const spentTotal = sources.reduce((s, x) => s + x.spent, 0);
    const remainTotal = total - spentTotal;
    const top = 14, avail = 190, gap = 8;
    const k = (avail - gap * (sources.length - 1)) / total; // 高さ 1 pt あたりの長さ
    const lx = 74, lw = 8, rx = 238, rw = 8;
    // 右の 2 つの箱（使った・残り）。使った分が上
    const rGap = 24;
    const rk = (avail - rGap) / total;
    const spentTop = top, remainTop = top + spentTotal * rk + rGap;
    let spentCur = spentTop, remainCur = remainTop, y = top;
    const link = (x0, y0a, y0b, x1, y1a, y1b) => {
      const xm = (x0 + x1) / 2;
      return `M ${x0} ${y0a} C ${xm} ${y0a}, ${xm} ${y1a}, ${x1} ${y1a} L ${x1} ${y1b} C ${xm} ${y1b}, ${xm} ${y0b}, ${x0} ${y0b} Z`;
    };
    sources.forEach((src) => {
      const h = src.earned * k;
      const remain = src.earned - src.spent;
      // 使った分の帯（上）と残りの帯（下）。帯の太さは左右で同じ（高さの倍率だけが違うので、右側は rk で測る）
      const sH = src.spent * k, rH = remain * k;
      const sR = src.spent * rk, rR = remain * rk;
      if (src.spent > 0) {
        const p = svgEl("path", { d: link(lx + lw, y, y + sH, rx, spentCur, spentCur + sR), fill: src.color, "fill-opacity": 0.5, class: "v-shape" });
        p.addEventListener("click", () => vizPick(p, `${src.name}: 使った ${formatCount(src.spent)} pt`));
        svg.append(p);
        spentCur += sR;
      }
      if (remain > 0) {
        const p = svgEl("path", { d: link(lx + lw, y + sH, y + sH + rH, rx, remainCur, remainCur + rR), fill: src.color, "fill-opacity": 0.28, class: "v-shape" });
        p.addEventListener("click", () => vizPick(p, `${src.name}: 残り ${formatCount(remain)} pt`));
        svg.append(p);
        remainCur += rR;
      }
      svg.append(svgEl("rect", { x: lx, y, width: lw, height: Math.max(1.5, h), rx: 2, fill: src.color }));
      vizLabel(svg, src.name, { class: "v-label v-label-day", x: lx - 6, y: y + Math.max(h, 10) / 2 + 3, "text-anchor": "end" });
      vizLabel(svg, `${formatCount(src.earned)}`, { x: lx - 6, y: y + Math.max(h, 10) / 2 + 13, "text-anchor": "end" });
      y += h + gap;
    });
    svg.append(svgEl("rect", { x: rx, y: spentTop, width: rw, height: Math.max(1.5, spentTotal * rk), rx: 2, fill: "#8378ff" }));
    svg.append(svgEl("rect", { x: rx, y: remainTop, width: rw, height: Math.max(1.5, remainTotal * rk), rx: 2, fill: "#62e7ff" }));
    vizLabel(svg, "使った", { class: "v-label v-label-day", x: rx + rw + 6, y: spentTop + 10 });
    vizLabel(svg, `${formatCount(spentTotal)} pt`, { x: rx + rw + 6, y: spentTop + 21 });
    vizLabel(svg, "残り", { class: "v-label v-label-day", x: rx + rw + 6, y: remainTop + 10 });
    vizLabel(svg, `${formatCount(remainTotal)} pt`, { x: rx + rw + 6, y: remainTop + 21 });
    vizLabel(svg, "貯めた元", { x: lx - 6, y: 8, "text-anchor": "end" });
    return "貯めたポイントの行き先。左が貯めた元（チャンネルごと）、右が使った分と残りです。帯が太いほど量が多いです。";
  }

  function hslToCss(h) {
    return `hsl(${h % 360} 72% 64%)`;
  }

  // ミニ推移（スモールマルチプル）: 4 つの項目の、直近 60 日の流れを、小さな面グラフで並べる。数字は直近 30 日と、その前の 30 日との比較
  function drawMulti(svg) {
    svg.setAttribute("viewBox", "0 0 320 300");
    const panels = [
      { key: "watch", name: "視聴時間", color: "#62e7ff" },
      { key: "comments", name: "コメント", color: "#8378ff" },
      { key: "fever", name: "激熱", color: "#ff6cb8" },
      { key: "points", name: "ポイント", color: "#ffb338" },
    ];
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    panels.forEach((p, idx) => {
      const x0 = 8 + (idx % 2) * 160, y0 = 6 + Math.floor(idx / 2) * 146, w = 144, h = 134;
      const vals = [];
      for (let i = 59; i >= 0; i--) {
        const row = byDate.get(localDateString(Date.now() - i * 86_400_000));
        vals.push(row ? vizDayValue(row, p.key) : 0);
      }
      const sm = vals.map((_, i) => { // 3 日のなめらかな平均
        const a = vals.slice(Math.max(0, i - 1), i + 2);
        return a.reduce((s, v) => s + v, 0) / a.length;
      });
      const cur = vals.slice(30).reduce((s, v) => s + v, 0);
      const prev = vals.slice(0, 30).reduce((s, v) => s + v, 0);
      const pct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
      const max = Math.max(...sm, 0.0001);
      const sx = (i) => x0 + 8 + (i / 59) * (w - 16);
      const sy = (v) => y0 + h - 12 - (v / max) * 52;
      const gid = `mini${idx}`;
      const defs = svgEl("defs");
      const g = svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      g.append(svgEl("stop", { offset: "0%", "stop-color": p.color, "stop-opacity": 0.5 }));
      g.append(svgEl("stop", { offset: "100%", "stop-color": p.color, "stop-opacity": 0 }));
      defs.append(g);
      svg.append(defs);
      const box = svgEl("rect", { class: "v-shape", x: x0, y: y0, width: w, height: h, rx: 14, fill: "rgba(255,255,255,0.045)", stroke: "rgba(170,180,255,0.14)" });
      box.addEventListener("click", () => vizPick(box, `${p.name}: 直近30日 ${graphFormat(p.key, cur)}${pct === null ? "" : `（その前の30日より ${pct >= 0 ? "+" : ""}${pct}%）`}`));
      svg.append(box);
      vizLabel(svg, p.name, { class: "v-label v-label-day", x: x0 + 12, y: y0 + 22 });
      const val = svgEl("text", { class: "v-label v-label-big", x: x0 + 12, y: y0 + 46 });
      val.textContent = graphFormat(p.key, cur);
      svg.append(val);
      const diff = svgEl("text", { class: "v-label", x: x0 + w - 10, y: y0 + 22, "text-anchor": "end", fill: pct === null ? "#aeb7dc" : pct >= 0 ? "#62e7ff" : "#c3b8ff" });
      diff.textContent = pct === null ? "—" : `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}%`;
      svg.append(diff);
      const pts = sm.map((v, i) => [sx(i), sy(v)]);
      svg.append(svgEl("path", { d: `${smoothPath(pts)} L ${sx(59)} ${y0 + h - 12} L ${sx(0)} ${y0 + h - 12} Z`, fill: `url(#${gid})`, "pointer-events": "none" }));
      svg.append(svgEl("path", { d: smoothPath(pts), fill: "none", stroke: p.color, "stroke-width": 1.8, "stroke-linejoin": "round", "pointer-events": "none" }));
    });
    return "直近60日の流れ（小さな面グラフ）。数字は直近30日で、右上はその前の30日との比較です。";
  }

  // ---- さらにいろいろなグラフ（ワッフル・山脈・サンバースト・ドットカレンダー・ダンベル・ふだんの1日） ----
  const VIZ_WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

  // 扇形（輪の一部）のパス。角度は度（12 時が -90）。360 度ちょうどだと描けないので、わずかに手前で止める
  function arcPath(cx, cy, rin, rout, a0, a1) {
    const end = Math.min(a1, a0 + 359.9);
    const p = (rad, deg) => `${(cx + rad * Math.cos((deg * Math.PI) / 180)).toFixed(2)} ${(cy + rad * Math.sin((deg * Math.PI) / 180)).toFixed(2)}`;
    const large = end - a0 > 180 ? 1 : 0;
    return `M ${p(rin, a0)} L ${p(rout, a0)} A ${rout} ${rout} 0 ${large} 1 ${p(rout, end)} L ${p(rin, end)} A ${rin} ${rin} 0 ${large} 0 ${p(rin, a0)} Z`;
  }

  // チャンネルごとの値を、上位 n 件 + その他 にまとめる（値の大きい順）
  function vizTopChannels(metric, n) {
    const sorted = DUMMY.channels
      .map((c) => ({ name: c.name, value: vizChannelValue(c, metric) }))
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value);
    const list = sorted.slice(0, n);
    const rest = sorted.slice(n).reduce((sum, c) => sum + c.value, 0);
    if (rest > 0) list.push({ name: "その他", value: rest });
    return list;
  }

  function vizColorOf(name, i) {
    return name === "その他" ? "rgb(150,162,205)" : VIZ_PALETTE[i % VIZ_PALETTE.length];
  }

  // ワッフル: 100 個のマスを、チャンネルの割合どおりに塗り分ける（1 マス = 1%）
  function drawWaffle(svg) {
    const { metric } = vizState;
    svg.setAttribute("viewBox", "0 0 320 330");
    const list = vizTopChannels(metric, 5);
    const total = list.reduce((sum, c) => sum + c.value, 0);
    if (total <= 0) return "まだデータがありません。";
    // 100 マスを、端数の大きい順に配る（合計がちょうど 100 になるように）
    const raw = list.map((c) => (c.value / total) * 100);
    const cnt = raw.map(Math.floor);
    let left = 100 - cnt.reduce((s, v) => s + v, 0);
    raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { cnt[i]++; left--; } });
    const size = 17, gap = 3.2;
    const x0 = (320 - (10 * size + 9 * gap)) / 2, y0 = 12;
    let idx = 0;
    list.forEach((c, k) => {
      for (let n = 0; n < cnt[k]; n++, idx++) {
        const cell = svgEl("rect", {
          class: "v-shape", x: x0 + (idx % 10) * (size + gap), y: y0 + Math.floor(idx / 10) * (size + gap),
          width: size, height: size, rx: 4, fill: vizColorOf(c.name, k),
        });
        cell.addEventListener("click", () => vizPick(cell, `${c.name}: ${graphFormat(metric, c.value)}（${cnt[k]}%）`));
        svg.append(cell);
      }
    });
    list.forEach((c, k) => {
      const x = k % 2 ? 176 : 28, y = 236 + Math.floor(k / 2) * 24;
      svg.append(svgEl("rect", { x, y: y - 9, width: 11, height: 11, rx: 3, fill: vizColorOf(c.name, k) }));
      vizLabel(svg, `${shortName(c.name, 7)}  ${cnt[k]}%`, { class: "v-label v-label-day", x: x + 17, y });
    });
    return "1マス＝1%。チャンネルの割合どおりに、100個のマスを塗り分けました。";
  }

  // 山脈（リッジライン）: 直近 12 か月の「日ごとの山」を、奥から手前へ重ねて並べる。山が高い日ほど多かった日
  function drawRidge(svg) {
    const { metric } = vizState;
    svg.setAttribute("viewBox", "0 0 320 300");
    const keys = graphBuckets("month");
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const months = keys.map((key) => {
      const [y, m] = key.split("-").map(Number);
      const days = new Date(y, m, 0).getDate();
      const vals = Array.from({ length: days }, (_, d) => {
        const row = byDate.get(`${key}-${String(d + 1).padStart(2, "0")}`);
        return row ? vizDayValue(row, metric) : 0;
      });
      return { key, vals, total: vals.reduce((s, v) => s + v, 0) };
    });
    const gmax = Math.max(...months.flatMap((m) => m.vals), 0.0001);
    const left = 28, right = 306, top0 = 64, step = 17, amp = 56;
    months.forEach((m, i) => {
      const base = top0 + i * step;
      const pts = m.vals.map((v, d) => [left + (d / 30) * (right - left), base - (v / gmax) * amp]);
      const stroke = `hsl(${(200 + i * 12) % 360} 80% 68%)`;
      // 手前の月が奥の月を隠すよう、地の色で塗りつぶしてから輪郭線を引く
      const body = svgEl("path", { class: "v-shape", d: `${smoothPath(pts)} L ${pts[pts.length - 1][0]} ${base} L ${left} ${base} Z`, fill: "rgb(18,22,58)" });
      body.addEventListener("click", () => vizPick(body, `${graphKeyLabel("month", m.key)}: ${graphFormat(metric, m.total)}`));
      svg.append(body);
      svg.append(svgEl("path", { d: smoothPath(pts), fill: "none", stroke, "stroke-width": 1.4, "stroke-linejoin": "round", "pointer-events": "none" }));
      vizLabel(svg, graphKeyLabel("month", m.key), { x: 2, y: base + 3 });
    });
    return "直近12か月の山脈。奥が古い月、手前が今月で、山が高い日ほど多かった日です。";
  }

  // サンバースト: 内側がチャンネルの視聴時間の割合、外側がそのうちライブ（濃い）とアーカイブ（薄い）の割合
  function drawSunburst(svg) {
    svg.setAttribute("viewBox", "0 0 320 300");
    const chans = DUMMY.channels.filter((c) => c.watchMs > 0).sort((a, b) => b.watchMs - a.watchMs).slice(0, 6);
    const total = chans.reduce((s, c) => s + c.watchMs, 0);
    if (total <= 0) return "まだデータがありません。";
    const cx = 160, cy = 116;
    let a = -90;
    chans.forEach((c, i) => {
      const sweep = (c.watchMs / total) * 360;
      const a1 = a + sweep;
      const color = VIZ_PALETTE[i % VIZ_PALETTE.length];
      const live = Math.min(1, c.liveWatchMs / c.watchMs);
      const mid = a + sweep * live;
      const inner = svgEl("path", { class: "v-shape", d: arcPath(cx, cy, 34, 70, a, a1), fill: color, stroke: "rgb(18,22,58)", "stroke-width": 1.2 });
      inner.addEventListener("click", () => vizPick(inner, `${c.name}: 視聴 ${formatWatchDuration(c.watchMs)}（全体の ${Math.round((c.watchMs / total) * 100)}%）`));
      svg.append(inner);
      if (mid > a + 0.2) {
        const l = svgEl("path", { class: "v-shape", d: arcPath(cx, cy, 73, 100, a, mid), fill: color, stroke: "rgb(18,22,58)", "stroke-width": 1.2 });
        l.addEventListener("click", () => vizPick(l, `${c.name} のライブ視聴: ${formatWatchDuration(c.liveWatchMs)}`));
        svg.append(l);
      }
      if (a1 > mid + 0.2) {
        const r = svgEl("path", { class: "v-shape", d: arcPath(cx, cy, 73, 100, mid, a1), fill: color, "fill-opacity": 0.4, stroke: "rgb(18,22,58)", "stroke-width": 1.2 });
        r.addEventListener("click", () => vizPick(r, `${c.name} のアーカイブ視聴: ${formatWatchDuration(c.watchMs - c.liveWatchMs)}`));
        svg.append(r);
      }
      a = a1;
    });
    vizLabel(svg, formatWatchDuration(total), { class: "v-label v-label-day", x: cx, y: cy + 3, "text-anchor": "middle" });
    chans.forEach((c, i) => {
      const x = i % 2 ? 176 : 28, y = 246 + Math.floor(i / 2) * 22;
      svg.append(svgEl("rect", { x, y: y - 9, width: 11, height: 11, rx: 3, fill: VIZ_PALETTE[i % VIZ_PALETTE.length] }));
      vizLabel(svg, `${shortName(c.name, 7)}  ${Math.round((c.watchMs / total) * 100)}%`, { class: "v-label v-label-day", x: x + 17, y });
    });
    return "視聴時間のサンバースト。内側がチャンネルの割合、外側は濃い色がライブ・薄い色がアーカイブです。";
  }

  // ドットカレンダー（パンチカード）: 14 週間 × 7 曜日を、丸の大きさで表す。大きい丸の日ほど多かった日
  function drawPunch(svg) {
    const { metric } = vizState;
    svg.setAttribute("viewBox", "0 0 320 250");
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const wdToday = (new Date().getDay() + 6) % 7;
    const startMs = Date.now() - (13 * 7 + wdToday) * 86_400_000;
    const cells = [];
    for (let w = 0; w < 14; w++) {
      for (let d = 0; d < 7; d++) {
        const ms = startMs + (w * 7 + d) * 86_400_000;
        if (ms > Date.now()) continue;
        const date = localDateString(ms);
        const row = byDate.get(date);
        cells.push({ w, d, date, value: row ? vizDayValue(row, metric) : 0 });
      }
    }
    const max = Math.max(...cells.map((c) => c.value), 0.0001);
    VIZ_WEEKDAYS.forEach((name, d) => vizLabel(svg, name, { class: "v-label v-label-day", x: 10, y: 24 + d * 29 }));
    cells.forEach((c) => {
      const ratio = c.value / max;
      const dot = svgEl("circle", {
        class: "v-shape", cx: 40 + c.w * 19.5, cy: 20 + c.d * 29, r: c.value > 0 ? 2.5 + Math.sqrt(ratio) * 8 : 1.5,
        fill: c.value > 0 ? `rgb(${solidGold(ratio).join(",")})` : "rgba(128,128,160,0.35)",
      });
      dot.addEventListener("click", () => vizPick(dot, `${c.date}: ${graphFormat(metric, c.value)}`));
      svg.append(dot);
    });
    for (let w = 0; w < 14; w += 3) {
      const d = new Date(startMs + w * 7 * 86_400_000);
      vizLabel(svg, `${d.getMonth() + 1}/${d.getDate()}`, { x: 40 + w * 19.5, y: 232, "text-anchor": "middle" });
    }
    return "直近14週間 × 曜日の丸。大きく明るい丸の日ほど、多かった日です（左が古い週、右が今週）。";
  }

  // ダンベル: 曜日ごとの「1日あたり」を、先月（白抜き）と今月（塗りつぶし）で結んで、増えたか減ったかを見る
  function drawDumbbell(svg) {
    const { metric } = vizState;
    svg.setAttribute("viewBox", "0 0 320 250");
    const now = new Date();
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const thisKey = ym(now), lastKey = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const agg = (key, lastDay) => {
      const out = Array.from({ length: 7 }, () => ({ sum: 0, days: 0 }));
      const [y, m] = key.split("-").map(Number);
      for (let d = 1; d <= lastDay; d++) {
        const date = `${key}-${String(d).padStart(2, "0")}`;
        const wd = (new Date(y, m - 1, d).getDay() + 6) % 7;
        out[wd].days += 1;
        const row = byDate.get(date);
        if (row) out[wd].sum += vizDayValue(row, metric);
      }
      return out.map((o) => (o.days ? o.sum / o.days : null));
    };
    const lastDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const cur = agg(thisKey, now.getDate());
    const prev = agg(lastKey, lastDays);
    const max = Math.max(...cur.filter((v) => v !== null), ...prev.filter((v) => v !== null), 0.0001);
    const left = 36, right = 296;
    const xOf = (v) => left + (v / max) * (right - left);
    svg.append(svgEl("circle", { cx: 150, cy: 12, r: 5, fill: "none", stroke: "#8378ff", "stroke-width": 2 }));
    vizLabel(svg, "先月", { x: 160, y: 15 });
    svg.append(svgEl("circle", { cx: 200, cy: 12, r: 5, fill: "#62e7ff" }));
    vizLabel(svg, "今月", { x: 210, y: 15 });
    VIZ_WEEKDAYS.forEach((name, d) => {
      const y = 42 + d * 28;
      vizLabel(svg, name, { class: "v-label v-label-day", x: 10, y: y + 3 });
      svg.append(svgEl("line", { class: "g-grid", x1: left, x2: right, y1: y, y2: y }));
      const a = prev[d], b = cur[d];
      if (a !== null && b !== null) {
        const bar = svgEl("line", { x1: xOf(a), x2: xOf(b), y1: y, y2: y, stroke: b >= a ? "#62e7ff" : "#8378ff", "stroke-width": 4, "stroke-linecap": "round", "stroke-opacity": 0.55 });
        svg.append(bar);
      }
      if (a !== null) {
        const dot = svgEl("circle", { class: "v-shape", cx: xOf(a), cy: y, r: 6, fill: "rgb(18,22,58)", stroke: "#8378ff", "stroke-width": 2 });
        dot.addEventListener("click", () => vizPick(dot, `${name}曜日（先月）: 1日あたり ${graphFormat(metric, a)}`));
        svg.append(dot);
      }
      if (b !== null) {
        const dot = svgEl("circle", { class: "v-shape", cx: xOf(b), cy: y, r: 6, fill: "#62e7ff" });
        dot.addEventListener("click", () => vizPick(dot, `${name}曜日（今月）: 1日あたり ${graphFormat(metric, b)}${a !== null ? `（先月は ${graphFormat(metric, a)}）` : ""}`));
        svg.append(dot);
      }
    });
    return "曜日ごとの1日あたりを、先月（白抜き）から今月（塗りつぶし）へ結びました。右へ伸びていれば増えています。";
  }

  // ふだんの1日（分布）: 直近 180 日の「1日の量」が、どのあたりに多いかをヒストグラムで見る（点線は活動した日の中央値）
  function drawHist(svg) {
    const { metric } = vizState;
    svg.setAttribute("viewBox", "0 0 320 250");
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const vals = [];
    for (let i = 179; i >= 0; i--) {
      const row = byDate.get(localDateString(Date.now() - i * 86_400_000));
      vals.push(row ? vizDayValue(row, metric) : 0);
    }
    const zeros = vals.filter((v) => v <= 0).length;
    const pos = vals.filter((v) => v > 0).sort((a, b) => a - b);
    if (pos.length === 0) return "まだデータがありません。";
    const max = pos[pos.length - 1];
    const BINS = 8;
    const counts = Array(BINS).fill(0);
    pos.forEach((v) => { counts[Math.min(BINS - 1, Math.floor((v / max) * BINS))]++; });
    const bars = [{ label: "0", count: zeros, color: "rgba(128,128,160,0.5)", range: "活動なし" }, ...counts.map((n, i) => ({
      label: i > 0 && i % 2 === 0 ? graphAxisLabel(metric, (max * i) / BINS) : "", // i=0 は左端の「0」と同じ値なので出さない
      count: n,
      color: `rgb(${solidGold(i / (BINS - 1)).join(",")})`,
      range: `${graphFormat(metric, (max * i) / BINS)}〜`,
    }))];
    const left = 18, right = 306, base = 190, top = 24;
    const cmax = Math.max(...bars.map((b) => b.count), 1);
    const bw = (right - left) / bars.length;
    bars.forEach((b, i) => {
      const h = (b.count / cmax) * (base - top);
      const rect = svgEl("rect", { class: "v-shape", x: left + i * bw + 3, y: base - h, width: bw - 6, height: Math.max(h, 1), rx: 4, fill: b.color });
      rect.addEventListener("click", () => vizPick(rect, `${b.range}の日: ${b.count} 日`));
      svg.append(rect);
      if (b.label) vizLabel(svg, b.label, { x: left + i * bw + bw / 2, y: base + 14, "text-anchor": "middle" });
    });
    svg.append(svgEl("line", { class: "g-grid", x1: left, x2: right, y1: base, y2: base }));
    const median = pos[Math.floor(pos.length / 2)];
    const mx = left + (1 + Math.min(BINS, (median / max) * BINS)) * bw;
    svg.append(svgEl("line", { x1: mx, x2: mx, y1: top - 6, y2: base, stroke: "#fff", "stroke-opacity": 0.7, "stroke-dasharray": "3 3" }));
    vizLabel(svg, `中央値 ${graphFormat(metric, median)}`, { class: "v-label v-label-day", x: Math.min(mx + 4, 250), y: top - 10 });
    vizLabel(svg, `活動した日 ${pos.length} 日 / 180 日`, { x: left, y: 232 });
    return "直近180日の「1日の量」の分布。棒が高いあたりが、ふだんの1日です（左端は活動のなかった日）。";
  }

  function renderViz() {
    const { type } = vizState;
    // 項目が決まっている図（バブル・達成リング・ストリーム・ポイントの流れ・ミニ推移・サンバースト）は、項目の切り替えを出さない
    document.getElementById("vizMetric").hidden = ["bubble", "rings", "stream", "sankey", "multi", "sunburst"].includes(type);
    const svg = document.getElementById("vizSvg");
    svg.replaceChildren();
    vizSel = null;
    document.getElementById("vizDetail").textContent = "タップすると詳しい値が見られます";
    const draw = {
      honey: drawHoney, rose: drawRose, tree: drawTree, bubble: drawBubble, growth: drawGrowth, radar: drawRadar,
      rings: drawRings, year: drawYear, stream: drawStream, sankey: drawSankey, multi: drawMulti,
      waffle: drawWaffle, ridge: drawRidge, sunburst: drawSunburst, punch: drawPunch, dumbbell: drawDumbbell, hist: drawHist,
    }[type];
    document.getElementById("vizNote").textContent = draw(svg);
  }

  function setupViz() {
    for (const [id, key] of [["vizType", "type"], ["vizMetric", "metric"]]) {
      document.getElementById(id).addEventListener("click", (e) => {
        const btn = e.target.closest(".seg-btn");
        if (!btn) return;
        vizState[key] = btn.dataset.value;
        document.querySelectorAll(`#${id} .seg-btn`).forEach((b) => b.classList.toggle("is-active", b === btn));
        renderViz();
      });
    }
  }

  // ============================================================
  // 🧊 立体グラフ（街・ハニカム柱・リング・タワー）
  //   外部のライブラリは使わず、SVG に「角柱（四角柱・六角柱）」を描くだけの小さな 3D で作る。
  //   柱の頂点を回転・斜め上からの視点で平面に写し、奥の柱から順に塗る（奥行きの順に描く）。
  //   ドラッグで左右に回せる。触らない間は、ゆっくり自動で回る（OS の「視覚効果を減らす」設定では回さない）
  // ============================================================
  const solidState = { type: "city", metric: "watch", look: "solid", angle: 0.6, auto: true, selected: -1 };
  const SOLID_TILT = 0.62; // 見下ろす角度（ラジアン）
  const SOLID_REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let solidScene = null; // { items, floor, scale, cy, labels, note }
  let solidDirty = true;
  let solidDragMoved = 0;
  let solidLastDraw = 0;
  let solidLastTick = 0;
  let solidRaf = 0;
  let solidRunning = false;

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 色の段階（少ない=深い藍 → 紫 → ピンク → 多い=淡い金）。暗い側も茶色くくすまないよう、青紫のまま明るくしていく
  const SOLID_RAMP = [
    [0, [52, 58, 170]],
    [0.35, [124, 92, 255]],
    [0.7, [255, 108, 184]],
    [1, [255, 218, 160]],
  ];
  function solidGold(ratio) {
    const t = Math.max(0, Math.min(1, ratio));
    let k = 0;
    while (k < SOLID_RAMP.length - 2 && t > SOLID_RAMP[k + 1][0]) k++;
    const [t0, c0] = SOLID_RAMP[k];
    const [t1, c1] = SOLID_RAMP[k + 1];
    const u = (t - t0) / (t1 - t0);
    return c0.map((v, i) => Math.round(v + (c1[i] - v) * u));
  }

  function hslToRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }

  function solidProject(x, y, z, ang, scale, cy) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rx = x * ca - z * sa;
    const rz = x * sa + z * ca;
    const ct = Math.cos(SOLID_TILT), st = Math.sin(SOLID_TILT);
    return { sx: 160 + rx * scale, sy: cy - (y * ct - rz * st) * scale, depth: rz * ct + y * st };
  }

  const SOLID_NIGHT = [18, 20, 58];
  function solidShade(rgb, k) {
    const c = (i) => {
      if (k >= 1) return Math.min(255, Math.round(rgb[i] + (255 - rgb[i]) * (k - 1) * 2)); // 上面: 少し白へ寄せて光って見せる
      return Math.round(SOLID_NIGHT[i] + (rgb[i] - SOLID_NIGHT[i]) * k); // 側面: 藍色へ寄せて影にする
    };
    return `rgb(${c(0)},${c(1)},${c(2)})`;
  }

  // ---- 場面づくり（柱の位置・高さ・色を決める） ----
  function solidCity(metric) {
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const today = new Date();
    const wdToday = (today.getDay() + 6) % 7; // 月曜始まり
    const startMs = Date.now() - (13 * 7 + wdToday) * 86_400_000;
    const cells = [];
    for (let w = 0; w < 14; w++) {
      for (let d = 0; d < 7; d++) {
        const ms = startMs + (w * 7 + d) * 86_400_000;
        if (ms > Date.now()) continue;
        const date = localDateString(ms);
        const row = byDate.get(date);
        cells.push({ w, d, date, value: row ? vizDayValue(row, metric) : 0 });
      }
    }
    const max = Math.max(...cells.map((c) => c.value), 0);
    const items = cells.map((c) => ({
      x: (c.w - 6.5) * 1.15, z: (c.d - 3) * 1.15, n: 4, r: 0.46 * Math.SQRT2, off: Math.PI / 4,
      h: max > 0 ? 0.12 + (c.value / max) * 7 : 0.12,
      color: solidGold(max > 0 ? c.value / max : 0),
      text: `${c.date}: ${graphFormat(metric, c.value)}`,
    }));
    return { items, floor: [[-9, -4.6], [9, -4.6], [9, 4.6], [-9, 4.6]], scale: 16, cy: 186, labels: false, note: "直近14週間の街。ビルが高い日ほど、多かった日です（手前が今週）。ドラッグで回せます。" };
  }

  function solidHex(metric) {
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const R = 0.56, w = Math.sqrt(3) * R * 1.05, rowH = 1.5 * R * 1.05;
    const cells = [];
    for (let i = 99; i >= 0; i--) {
      const date = localDateString(Date.now() - i * 86_400_000);
      const row = byDate.get(date);
      cells.push({ date, value: row ? vizDayValue(row, metric) : 0 });
    }
    const max = Math.max(...cells.map((c) => c.value), 0);
    const items = cells.map((c, idx) => {
      const rr = Math.floor(idx / 10), cc = idx % 10;
      return {
        x: (cc + (rr % 2 ? 0.5 : 0) - 4.75) * w, z: (rr - 4.5) * rowH, n: 6, r: R, off: Math.PI / 6,
        h: max > 0 ? 0.12 + (c.value / max) * 5 : 0.12,
        color: solidGold(max > 0 ? c.value / max : 0),
        text: `${c.date}: ${graphFormat(metric, c.value)}`,
      };
    });
    return { items, floor: [[-5.6, -5.2], [5.6, -5.2], [5.6, 5.2], [-5.6, 5.2]], scale: 22, cy: 182, labels: false, note: "直近100日のハニカム柱。柱が高い日ほど、多かった日です。ドラッグで回せます。" };
  }

  function solidRing(metric) {
    const keys = graphBuckets("month");
    const sums = new Map(keys.map((k) => [k, 0]));
    for (const row of DUMMY.activity) {
      const k = row.date.slice(0, 7);
      if (sums.has(k)) sums.set(k, sums.get(k) + vizDayValue(row, metric));
    }
    const max = Math.max(...sums.values(), 0);
    const items = keys.map((key, i) => {
      const a = (i / 12) * Math.PI * 2;
      const v = sums.get(key);
      return {
        x: Math.cos(a) * 4.6, z: Math.sin(a) * 4.6, n: 4, r: 0.8 * Math.SQRT2, off: Math.PI / 4 + a,
        h: max > 0 ? 0.15 + (v / max) * 6 : 0.15,
        color: hslToRgb(180 + (i / 11) * 150, 0.72, 0.64),
        label: graphKeyLabel("month", key),
        text: `${graphKeyLabel("month", key)}: ${graphFormat(metric, v)}`,
      };
    });
    const floor = Array.from({ length: 28 }, (_, k) => [Math.cos((k / 28) * Math.PI * 2) * 6.2, Math.sin((k / 28) * Math.PI * 2) * 6.2]);
    return { items, floor, scale: 24, cy: 178, labels: true, note: "直近12か月のリング。柱が高い月ほど、たくさんあった月です。ドラッグで回せます。" };
  }

  function solidTower(metric) {
    const list = DUMMY.channels
      .map((c) => ({ name: c.name, value: vizChannelValue(c, metric) }))
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    const max = list.length ? list[0].value : 0;
    const items = list.map((c, i) => ({
      x: ((i % 4) - 1.5) * 2.3, z: (Math.floor(i / 4) - 0.5) * 2.6, n: 4, r: 0.85 * Math.SQRT2, off: Math.PI / 4,
      h: 0.3 + (c.value / max) * 6,
      color: i === 0 ? [255, 214, 150] : hslToRgb(200 + ((i - 1) / 6) * 140, 0.72, 0.64),
      label: shortName(c.name, 6),
      text: `${c.name}: ${graphFormat(metric, c.value)}`,
    }));
    return { items, floor: [[-5.2, -3.2], [5.2, -3.2], [5.2, 3.2], [-5.2, 3.2]], scale: 26, cy: 196, labels: true, note: list.length ? "チャンネルのタワー（上位8件）。高いチャンネルほど、たくさんあります。ドラッグで回せます。" : "まだデータがありません。" };
  }

  // ガラス用: 色を白へ寄せた透明な色（rgba）。柱どうしが重なっても奥が透けて見える
  function solidGlass(rgb, mixWhite, alpha) {
    const c = (i) => Math.round(rgb[i] + (255 - rgb[i]) * mixWhite);
    return `rgba(${c(0)},${c(1)},${c(2)},${alpha})`;
  }

  // 2 点の間・2 点の高さの間を 0〜1 で補間した位置（面の中に光の筋を描くのに使う）
  function solidLerpFace(b0, b1, t0, t1, u, v) {
    const ax = b0.sx + (b1.sx - b0.sx) * u, ay = b0.sy + (b1.sy - b0.sy) * u;
    const bx = t0.sx + (t1.sx - t0.sx) * u, by = t0.sy + (t1.sy - t0.sy) * u;
    return `${(ax + (bx - ax) * v).toFixed(1)},${(ay + (by - ay) * v).toFixed(1)}`;
  }

  // 柱の底面の頂点と、各側面の外向きの向き（x,z 平面）。底面は正 n 角形（四角柱・六角柱）
  function solidGeometry(it) {
    if (it._geo) return it._geo;
    const verts = [], normals = [];
    for (let k = 0; k < it.n; k++) {
      const a = it.off + (k * 2 * Math.PI) / it.n;
      verts.push([it.x + it.r * Math.cos(a), it.z + it.r * Math.sin(a)]);
      const na = it.off + ((k + 0.5) * 2 * Math.PI) / it.n;
      normals.push([Math.cos(na), Math.sin(na)]);
    }
    it._geo = { verts, normals };
    return it._geo;
  }

  // ---- 見た目（ソリッド・ガラス・ネオン・オーロラ・ゴールド） ----
  //   ガラス・ネオン・オーロラは「透ける見た目」: 向こう側の面も描き（奥→手前の順）、柱の中が透けて見える。
  //   ソリッド・ゴールドは「塗りつぶす見た目」: 手前を向いた面だけを描く
  const SOLID_TRANSLUCENT = new Set(["glass", "neon", "aurora"]);
  const SOLID_METAL = [
    [0, [96, 60, 24]],
    [0.4, [205, 152, 60]],
    [0.75, [248, 212, 124]],
    [1, [255, 242, 206]],
  ];

  // 色の段階（SOLID_RAMP・SOLID_METAL のような [位置, 色] の並び）から、位置 t（0〜1）の色を求める
  function rampColor(ramp, t) {
    const x = Math.max(0, Math.min(1, t));
    let k = 0;
    while (k < ramp.length - 2 && x > ramp[k + 1][0]) k++;
    const [t0, c0] = ramp[k];
    const [t1, c1] = ramp[k + 1];
    const u = (x - t0) / (t1 - t0);
    return c0.map((v, i) => Math.round(v + (c1[i] - v) * u));
  }

  function solidMix(a, b, t) {
    return a.map((v, i) => Math.round(v + (b[i] - v) * t));
  }

  function rgbCss(c) {
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function rgbHue(c) {
    const [r, g, b] = c.map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  // 側面 1 枚の塗りと縁。f = { light: 明るさ(0〜1), rnx: 回した後の向き(横), front: 手前を向いているか }
  function solidFaceStyle(look, it, f, ang) {
    if (look === "glass") {
      return { fill: solidGlass(it.color, 0.04 + 0.14 * f.light, f.front ? 0.26 + 0.2 * f.light : 0.13 + 0.1 * f.light), stroke: `rgba(255,255,255,${f.front ? 0.42 : 0.2})`, sw: 0.8 };
    }
    if (look === "neon") {
      return { fill: `rgba(8,10,36,${f.front ? 0.5 : 0.22})`, stroke: solidGlass(it.color, 0.3, f.front ? 0.95 : 0.4), sw: f.front ? 1.3 : 0.9 };
    }
    if (look === "aurora") {
      // 面の向きと回転角で色相がずれる＝回すとオーロラのように色が流れる
      const hue = (rgbHue(it.color) + f.rnx * 80 + ang * 57 + 720) % 360;
      return { fill: `hsla(${hue.toFixed(0)},85%,${(55 + 8 * f.light).toFixed(0)}%,${f.front ? 0.5 : 0.22})`, stroke: `rgba(255,255,255,${f.front ? 0.35 : 0.15})`, sw: 0.8 };
    }
    if (look === "gold") {
      const metal = rampColor(SOLID_METAL, Math.min(1, it.h / 6));
      return { fill: rgbCss(solidMix([38, 22, 8], metal, Math.min(1, Math.pow(f.light, 1.7) * 1.1))), stroke: "none", sw: 0 };
    }
    return { fill: solidShade(it.color, f.light * 0.95), stroke: "none", sw: 0 }; // ソリッド
  }

  // 上の面の塗りと縁（sel = タップで選ばれている柱）
  function solidTopStyle(look, it, ang, sel) {
    const sw = sel ? 2 : 1;
    if (look === "glass") return { fill: solidGlass(it.color, 0.22, 0.5), stroke: sel ? "#fff" : "rgba(255,255,255,0.65)", sw };
    if (look === "neon") return { fill: solidGlass(it.color, 0.1, 0.3), stroke: sel ? "#fff" : solidGlass(it.color, 0.5, 1), sw: sel ? 2.4 : 1.8 };
    if (look === "aurora") {
      const hue = (rgbHue(it.color) + 40 + ang * 57 + 720) % 360;
      return { fill: `hsla(${hue.toFixed(0)},90%,72%,0.65)`, stroke: sel ? "#fff" : "rgba(255,255,255,0.6)", sw };
    }
    if (look === "gold") return { fill: rgbCss(rampColor(SOLID_METAL, Math.min(1, it.h / 6) + 0.18)), stroke: sel ? "#fff" : "rgba(255,250,230,0.6)", sw };
    return { fill: solidShade(it.color, 1.12), stroke: sel ? "#fff" : "rgba(255,255,255,0.28)", sw }; // ソリッド
  }

  // ---- 追加の場面（らせん・ドーナツ・地形・ウォール・積み上げ） ----
  //   it.y0 = 柱の底の高さ（積み上げ・らせん用）、it.lx / it.lz / it.ly = ラベルを置く位置（柱の真上ではなく別の所に出したい時）

  // 直近 days 日の日別の値（古い順）
  function solidDays(metric, days) {
    const byDate = new Map(DUMMY.activity.map((r) => [r.date, r]));
    const cells = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = localDateString(Date.now() - i * 86_400_000);
      const row = byDate.get(date);
      cells.push({ date, value: row ? vizDayValue(row, metric) : 0 });
    }
    return cells;
  }

  // らせん: 100 日分の柱が、らせん階段のように 1 周ずつ上へ登っていく（古い日が下、今日が上）
  function solidHelix(metric) {
    const cells = solidDays(metric, 100);
    const max = Math.max(...cells.map((c) => c.value), 0);
    const items = cells.map((c, i) => {
      const a = i * 0.4;
      const ratio = max > 0 ? c.value / max : 0;
      return {
        x: Math.cos(a) * 4.2, z: Math.sin(a) * 4.2, n: 4, r: 0.4 * Math.SQRT2, off: Math.PI / 4 + a,
        y0: (i / 99) * 4.2, h: 0.12 + ratio * 3.2, color: solidGold(ratio),
        text: `${c.date}: ${graphFormat(metric, c.value)}`,
      };
    });
    const floor = Array.from({ length: 28 }, (_, k) => [Math.cos((k / 28) * Math.PI * 2) * 5.8, Math.sin((k / 28) * Math.PI * 2) * 5.8]);
    return { items, floor, scale: 21, cy: 204, labels: false, note: "直近100日のらせん。下から上へ時間が進み、柱が高い日ほど多かった日です。ドラッグで回せます。" };
  }

  // 積み上げ: 月ごとの柱を 3 段に積む（上旬・中旬・下旬。ポイントは 共通・チャンネル の 2 段）
  function solidStack(metric) {
    const keys = graphBuckets("month");
    const isPoints = metric === "points";
    const parts = new Map(keys.map((k) => [k, isPoints ? [0, 0] : [0, 0, 0]]));
    for (const row of DUMMY.activity) {
      const arr = parts.get(row.date.slice(0, 7));
      if (!arr) continue;
      if (isPoints) { arr[0] += row.commonPoints; arr[1] += row.channelPoints; } else {
        const day = Number(row.date.slice(8, 10));
        arr[day <= 10 ? 0 : day <= 20 ? 1 : 2] += vizDayValue(row, metric);
      }
    }
    const colors = isPoints ? [[255, 207, 51], [91, 155, 255]] : [[98, 231, 255], [131, 120, 255], [255, 108, 184]];
    const names = isPoints ? ["", "チャンネル"] : ["上旬", "中旬", "下旬"]; // 下の段（旧 共通ポイント）は常に 0 なので名前を出さない（2026-10-17）
    const max = Math.max(...[...parts.values()].map((a) => a.reduce((s, v) => s + v, 0)), 0);
    const items = [];
    keys.forEach((key, i) => {
      let y0 = 0;
      const arr = parts.get(key);
      const lastIdx = arr.reduce((acc, v, j) => (v > 0 ? j : acc), -1);
      arr.forEach((v, j) => {
        if (v <= 0 || max <= 0) return;
        const h = (v / max) * 6;
        items.push({
          x: (i - 5.5) * 1.15, z: 0, n: 4, r: 0.44 * Math.SQRT2, off: Math.PI / 4, y0, h, color: colors[j],
          label: j === lastIdx ? graphKeyLabel("month", key) : "",
          text: `${graphKeyLabel("month", key)} ${names[j]}: ${graphFormat(metric, v)}`,
        });
        y0 += h;
      });
    });
    return { items, floor: [[-7.4, -1.8], [7.4, -1.8], [7.4, 1.8], [-7.4, 1.8]], scale: 21, cy: 192, labels: true, note: isPoints ? "直近12か月の積み上げ（チャンネルポイント）。ドラッグで回せます。" : "直近12か月の積み上げ（下から 上旬・中旬・下旬）。ドラッグで回せます。" };
  }

  // グループ: 上位 5 チャンネルを、視聴・コメント・激熱・ポイントの 4 本ずつの棒で見比べる（各項目は、自分の最大に合わせた高さ）
  function solidGroup() {
    const lanes = [
      { key: "watch", name: "視聴", color: [98, 231, 255] },
      { key: "comments", name: "コメント", color: [131, 120, 255] },
      { key: "fever", name: "激熱", color: [255, 108, 184] },
      { key: "points", name: "ポイント", color: [255, 200, 120] },
    ];
    const chans = [...DUMMY.channels].sort((a, b) => b.watchMs - a.watchMs).slice(0, 5);
    const maxOf = Object.fromEntries(lanes.map((l) => [l.key, Math.max(...chans.map((c) => vizChannelValue(c, l.key)), 0)]));
    const items = [];
    chans.forEach((c, gi) => {
      const gx = (gi - (chans.length - 1) / 2) * 2.7;
      lanes.forEach((lane, li) => {
        const v = vizChannelValue(c, lane.key);
        const ratio = maxOf[lane.key] > 0 ? v / maxOf[lane.key] : 0;
        items.push({
          x: gx + (li - 1.5) * 0.56, z: 0, n: 4, r: 0.23 * Math.SQRT2, off: Math.PI / 4, h: 0.1 + ratio * 4.6,
          color: solidMix([34, 40, 110], lane.color, 0.4 + 0.6 * ratio),
          label: li === 0 ? shortName(c.name, 5) : "", lx: gx, lz: 1.5, ly: 0.2,
          text: `${c.name} の${lane.name}: ${graphFormat(lane.key, v)}`,
        });
      });
    });
    return {
      items, floor: [[-7.2, -1.8], [7.2, -1.8], [7.2, 1.8], [-7.2, 1.8]], scale: 19, cy: 196, labels: true,
      note: "チャンネルごとの4本組（左から 視聴・コメント・激熱・ポイント）。各項目は、自分の最大に合わせた高さです。ドラッグで回せます。",
    };
  }

  // ---- 描画（今の角度で 1 コマ描く） ----
  function solidFrame() {
    const svg = document.getElementById("solidSvg");
    if (!svg || !solidScene) return;
    const { items, floor, scale, cy, labels } = solidScene;
    const { look } = solidState;
    const translucent = SOLID_TRANSLUCENT.has(look);
    const ang = solidState.angle;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    svg.classList.toggle("solid-neon", look === "neon"); // ネオンだけ、全体に光のにじみを足す
    let out = "";

    const fl = floor.map(([x, z]) => solidProject(x, 0, z, ang, scale, cy));
    out += `<polygon points="${fl.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(" ")}" fill="rgba(124,110,255,0.10)" stroke="rgba(170,160,255,0.4)"/>`;

    const order = items
      .map((it, i) => ({ it, i, depth: solidProject(it.x, 0, it.z, ang, scale, cy).depth }))
      .sort((a, b) => a.depth - b.depth); // 奥（深さが小さい）→手前の順に塗る
    const blend = look === "glass" || look === "aurora";
    if (blend) out += '<g style="mix-blend-mode:screen">'; // 透けた面が重なるほど明るくなる（光を通す見え方）
    for (const { it, i } of order) {
      const geo = solidGeometry(it);
      const nSides = geo.verts.length;
      const y0 = it.y0 ?? 0;
      const base = [], top = [];
      for (const [x, z] of geo.verts) {
        base.push(solidProject(x, y0, z, ang, scale, cy));
        top.push(solidProject(x, y0 + it.h, z, ang, scale, cy));
      }
      const pts = (arr) => arr.map((q) => `${q.sx.toFixed(1)},${q.sy.toFixed(1)}`).join(" ");
      const faces = [];
      for (let k = 0; k < nSides; k++) {
        const [nx, nz] = geo.normals[k];
        const rnx = nx * ca - nz * sa, rnz = nx * sa + nz * ca;
        if (!translucent && rnz <= -0.001) continue; // 塗りつぶす見た目では、向こう側を向いた面は見えない
        faces.push({ k, rnx, rnz, front: rnz > 0, light: 0.42 + 0.58 * Math.max(0, rnx * -0.45 + rnz * 0.82) });
      }
      if (translucent) faces.sort((a, b) => a.rnz - b.rnz); // 透ける見た目は、奥を向いた面から先に重ねる
      for (const f of faces) {
        const k2 = (f.k + 1) % nSides;
        const st = solidFaceStyle(look, it, f, ang);
        out += `<polygon points="${pts([base[f.k], base[k2], top[k2], top[f.k]])}" fill="${st.fill}"${st.sw ? ` stroke="${st.stroke}" stroke-width="${st.sw}" stroke-linejoin="round"` : ""} data-i="${i}"/>`;
      }
      const sel = solidState.selected === i;
      const tt = solidTopStyle(look, it, ang, sel);
      out += `<polygon points="${pts(top)}" fill="${tt.fill}" stroke="${tt.stroke}" stroke-width="${tt.sw}" stroke-linejoin="round" data-i="${i}"/>`;
      if (look === "glass" && items.length <= 16 && faces.length) {
        // 柱の数が少ない時だけ、いちばん手前の面に細い光の筋（ガラスの反射）を入れる
        const f = faces[faces.length - 1];
        const k2 = (f.k + 1) % nSides;
        const streak = [[0.14, 0.08], [0.3, 0.08], [0.3, 0.9], [0.14, 0.9]]
          .map(([u, v]) => solidLerpFace(base[f.k], base[k2], top[f.k], top[k2], u, v)).join(" ");
        out += `<polygon points="${streak}" fill="rgba(255,255,255,0.2)" pointer-events="none"/>`;
      }
    }
    if (blend) out += "</g>";
    if (labels) {
      for (const { it } of order) {
        if (!it.label) continue;
        const p = solidProject(it.lx ?? it.x, it.ly ?? (it.y0 ?? 0) + it.h + 0.5, it.lz ?? it.z, ang, scale, cy);
        out += `<text class="v-label v-label-day" x="${p.sx.toFixed(1)}" y="${p.sy.toFixed(1)}" text-anchor="middle">${esc(it.label)}</text>`;
      }
    }
    svg.innerHTML = out;
  }

  // グラフ上部のサマリー: 今月の合計と、先月の同じ日までとの差（選んでいる項目に合わせる）
  function renderSolidSummary() {
    const metric = solidState.metric;
    const now = new Date();
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const thisKey = ym(now);
    const lastKey = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    let cur = 0, prev = 0;
    for (const r of DUMMY.activity) {
      if (r.date.startsWith(thisKey)) cur += vizDayValue(r, metric);
      else if (r.date.startsWith(lastKey) && Number(r.date.slice(8, 10)) <= now.getDate()) prev += vizDayValue(r, metric);
    }
    const diff = cur - prev;
    document.getElementById("solidSumLabel").textContent = `今月の${METRIC_LABEL[metric]}`;
    document.getElementById("solidSumValue").textContent = graphFormat(metric, cur);
    const el = document.getElementById("solidSumDiff");
    el.textContent = `${diff >= 0 ? "+" : "−"}${graphFormat(metric, Math.abs(diff))} ${diff >= 0 ? "↗" : "↘"}`;
    el.className = `solid-sum-value ${diff >= 0 ? "is-up" : "is-down"}`;
  }

  function renderSolid() {
    const { type, metric } = solidState;
    solidScene = { city: solidCity, hex: solidHex, ring: solidRing, tower: solidTower, helix: solidHelix, stack: solidStack, group: solidGroup }[type](metric);
    const noMetric = type === "group"; // グループは 4 つの項目を同時に並べるので、項目の切り替えとサマリーは使わない
    document.getElementById("solidMetric").hidden = noMetric;
    document.querySelector(".solid-summary").hidden = noMetric;
    solidState.selected = -1;
    document.getElementById("solidDetail").textContent = "柱をタップで値を表示";
    document.getElementById("solidNote").textContent = "ドラッグで回せます";
    document.getElementById("solidSvg").setAttribute("aria-label", solidScene.note);
    renderSolidSummary();
    solidDirty = true;
    solidFrame();
  }

  // グラフのタブが見えていて、カードが画面の中にある時だけ回す（2026-10-19）
  function solidCardVisible() {
    const view = document.getElementById("view-graph");
    const card = document.getElementById("solidCard");
    if (!view || view.hidden || document.hidden || !card) return false;
    const r = card.getBoundingClientRect();
    const h = window.innerHeight || document.documentElement.clientHeight || 0;
    return r.width > 0 && r.bottom > 0 && r.top < h;
  }
  function solidStart() {
    if (solidRunning) return;
    solidRunning = true;
    solidLastTick = 0;
    solidRaf = window.requestAnimationFrame(solidTick);
  }
  function solidStop() {
    solidRunning = false;
    if (solidRaf) window.cancelAnimationFrame(solidRaf);
    solidRaf = 0;
    solidLastTick = 0;
  }
  function solidSync() {
    if (solidCardVisible()) solidStart();
    else solidStop();
  }

  function solidTick(t) {
    if (!solidRunning) return;
    if (!solidCardVisible()) {
      solidStop();
      return;
    }
    const svg = document.getElementById("solidSvg");
    if (svg) {
      if (!solidLastTick) solidLastTick = t;
      if (solidState.auto && !SOLID_REDUCED_MOTION) {
        solidState.angle += (t - solidLastTick) * 0.00028;
        solidDirty = true;
      }
      if (solidDirty && t - solidLastDraw > 33) { // 描き直しは毎秒 30 コマまで（柱が多くても軽く保つ）
        solidDirty = false;
        solidLastDraw = t;
        solidFrame();
      }
    }
    solidLastTick = t;
    if (!solidRunning) return;
    solidRaf = window.requestAnimationFrame(solidTick);
  }

  function setupSolid() {
    for (const [id, key] of [["solidType", "type"], ["solidLook", "look"], ["solidMetric", "metric"]]) {
      document.getElementById(id).addEventListener("click", (e) => {
        const btn = e.target.closest(".seg-btn");
        if (!btn) return;
        solidState[key] = btn.dataset.value;
        document.querySelectorAll(`#${id} .seg-btn`).forEach((b) => b.classList.toggle("is-active", b === btn));
        renderSolid();
      });
    }
    const svg = document.getElementById("solidSvg");
    let dragging = false;
    let lastX = 0;
    let solidDownIndex = NaN; // 押した柱の番号。回している間は図形が作り直され click が届かない（2026-10-19）
    svg.addEventListener("pointerdown", (e) => {
      solidDownIndex = Number(e.target.dataset?.i);
      dragging = true;
      lastX = e.clientX;
      solidDragMoved = 0;
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      solidDragMoved += Math.abs(dx);
      if (solidDragMoved > 4) {
        solidState.auto = false; // 触っている間・触った後は自動で回さない
        solidState.angle += dx * 0.012;
        solidDirty = true;
      }
    });
    window.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      const i = solidDownIndex;
      solidDownIndex = NaN;
      if (solidDragMoved > 4) return; // ドラッグの終わりは、選んだことにしない
      if (!Number.isInteger(i) || !solidScene?.items[i]) return;
      solidState.selected = i;
      solidState.auto = false;
      document.getElementById("solidDetail").textContent = solidScene.items[i].text;
      solidDirty = true;
      if (!solidRunning) solidFrame();
    });
    document.getElementById("view-graph").addEventListener("scroll", solidSync);
    window.addEventListener("resize", solidSync);
  }

  // ============================================================
  // 🔎 そのほかの実績（ポイントの収支・推し歴と年表・ストリーク）
  //   どれも拡張機能がすでに数えて同期している値（user_channel_stats・user_daily_activity）から、
  //   ここで計算するだけ。新しい測定は要らない
  // ============================================================
  // ストリーク（継続日数）: 見た・書いた日が続いた日数と最長。今日か昨日まで続いていれば「今」の値
  function computeStreak(rows) {
    const days = [...new Set(rows.filter((r) => r.watchMs > 0 || r.commentCount > 0).map((r) => r.date))].sort();
    const dayNo = (d) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);
    let longest = 0, run = 0, prev = null;
    for (const d of days) {
      run = prev && dayNo(d) - dayNo(prev) === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = d;
    }
    const today = localDateString(Date.now());
    const yesterday = localDateString(Date.now() - 86_400_000);
    const current = prev === today || prev === yesterday ? run : 0;
    const tier = current >= 30 ? "gold" : current >= 7 ? "silver" : current >= 3 ? "bronze" : "none";
    return { current, longest, tier };
  }

  // ============================================================
  // 📺 チャンネルごとのページ（ホームの一覧から開く。2026-10-14 依頼者）とインデックス
  //   段の決め方は拡張機能の src/core/index-badges.js と同じ（しきい値・周回）。**段の名前（モチーフ）は持ち込まない**（2026-10-10 依頼者決定:
  //   モチーフは公開しない。この app.js は公開リポジトリに置くため、番号だけ）。絵は images/index/<id>.webp（拡張機能と同じファイル）
  // ============================================================
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  const INDEX_SERIES = [
    { kind: "watch", label: "視聴時間", unit: "hours", value: (e) => e.watchMs ?? 0, laps: { count: 3, span: 1100 * HOUR, mark: "e" },
      ranks: [10, 40, 70, 100, 150, 200, 300, 400, 550, 700, 900, 1100].map((h) => h * HOUR) },
    { kind: "comment", label: "コメント", unit: "count", value: (e) => e.commentSendCount ?? 0, ranks: [10, 25, 50, 100, 250, 500, 1000, 1500, 2000, 3000] },
    { kind: "fever", label: "激熱", unit: "count", value: (e) => e.feverCount ?? 0, ranks: [5, 10, 20, 35, 60, 100, 150, 250, 400, 600] },
    { kind: "veteran", label: "古参", unit: "days", value: (e, now) => (e.firstWatchAt ? now - e.firstWatchAt : 0), laps: { count: 4, span: 365 * DAY, mark: "" },
      ranks: [7, 30, 60, 90, 180, 270, 365].map((d) => d * DAY) },
    { kind: "cheer", label: "大応援", unit: "count", value: (e) => e.cheerCount ?? 0, ranks: [1, 10, 30, 100, 300] },
  ];
  const INDEX_BADGES = INDEX_SERIES.flatMap((s) => Array.from({ length: s.laps?.count ?? 1 }, (_, l) => l + 1)
    .flatMap((lap) => s.ranks.map((base, i) => {
      const at = base + (lap - 1) * (s.laps?.span ?? 0);
      return { id: `${s.kind}_r${String(i + 1).padStart(2, "0")}${lap > 1 ? `_lap${lap}${s.laps.mark}` : ""}`, kind: s.kind, tier: i + 1, lap, at,
        test: (e, now) => !!e && s.value(e, now) >= at };
    })));
  // 視聴実績 e から、種類ごとの「一番上の段」と「次の段まで」を出す
  function indexStatus(e, now = Date.now()) {
    return INDEX_SERIES.map((s) => {
      const list = INDEX_BADGES.filter((b) => b.kind === s.kind);
      let top = null;
      let next = null;
      for (const b of list) {
        if (b.test(e, now)) top = b;
        else if (!next) next = b;
      }
      return { series: s, top, next, remaining: next ? next.at - s.value(e, now) : 0, first: list[0] };
    });
  }
  // 並び順（profiles.index_order。種類の id の配列）。入っていない種類は元の順で後ろに
  function applyIndexOrder(items, order) {
    const known = new Map(items.map((it) => [it.series.kind, it]));
    const out = [];
    for (const k of order ?? []) if (known.has(k) && !out.includes(known.get(k))) out.push(known.get(k));
    for (const it of items) if (!out.includes(it)) out.push(it);
    return out;
  }
  function formatRemaining(unit, remaining) {
    if (unit === "hours") {
      const minutes = Math.ceil(remaining / 60_000);
      return minutes >= 60 ? `あと ${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分` : `あと ${minutes} 分`;
    }
    if (unit === "days") return `あと ${Math.ceil(remaining / DAY)} 日`;
    return `あと ${formatCount(remaining)} 回`;
  }

  function channelAvatarEl(ch, i, className) {
    const wrap = document.createElement("span");
    wrap.className = className;
    if (ch.avatarUrl) {
      const img = document.createElement("img");
      img.src = ch.avatarUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      wrap.append(img);
    } else {
      wrap.textContent = initialOf(ch.name);
      wrap.style.background = colorFor(i);
    }
    return wrap;
  }

  // ホームの「チャンネルごとの記録」の一覧（視聴時間の多い順）
  function renderChannelList() {
    const list = document.getElementById("channelList");
    list.replaceChildren();
    const channels = [...DUMMY.channels].sort((a, b) => b.watchMs - a.watchMs);
    if (!channels.length) {
      const empty = document.createElement("li");
      empty.className = "points-empty";
      empty.textContent = "まだデータがありません。";
      list.append(empty);
      return;
    }
    channels.forEach((ch, i) => {
      const row = document.createElement("li");
      row.className = "points-channel-row is-link";
      const name = document.createElement("span");
      name.className = "points-channel-name";
      name.textContent = ch.name; // 配信者名は外部由来の文字列なので textContent で入れる
      const val = document.createElement("span");
      val.className = "points-channel-pt";
      val.textContent = formatWatchDuration(ch.watchMs);
      row.append(channelAvatarEl(ch, i, "points-channel-avatar"), name, val);
      row.addEventListener("click", () => openChannel(ch, i));
      list.append(row);
    });
  }

  function openChannel(ch, i = 0) {
    const avatar = document.getElementById("channelAvatar");
    avatar.replaceWith(Object.assign(channelAvatarEl(ch, i, "channel-avatar"), { id: "channelAvatar" }));
    document.getElementById("channelName").textContent = ch.name;
    const since = ch.firstWatchAt ? new Date(ch.firstWatchAt) : null;
    document.getElementById("channelSince").textContent = since
      ? `${since.getFullYear()}年${since.getMonth() + 1}月${since.getDate()}日 から見ている`
      : "";

    const stats = [
      { icon: STAT_ICONS_CH.watch, value: formatWatchDuration(ch.watchMs), label: `視聴時間（ライブ ${formatWatchDuration(ch.liveWatchMs)}）` },
      { icon: STAT_ICONS_CH.comments, value: formatCount(ch.comments), label: "コメント送信数" },
      { icon: STAT_ICONS_CH.fever, value: `${formatCount(ch.fever)} 回`, label: "激熱経験回数" },
    ];
    document.getElementById("channelStats").innerHTML = stats.map((s, k) => `
      <div class="card stat-card${k === 0 ? " span-2" : ""}">
        <span class="stat-icon">${s.icon}</span>
        <span class="stat-value">${esc(s.value)}</span>
        <span class="stat-label">${esc(s.label)}</span>
      </div>`).join("");

    const e = { watchMs: ch.watchMs, commentSendCount: ch.comments, feverCount: ch.fever, firstWatchAt: ch.firstWatchAt, cheerCount: ch.cheer ?? 0 };
    const items = applyIndexOrder(indexStatus(e), DUMMY.profile.indexOrder);
    const list = document.getElementById("indexList");
    list.replaceChildren();
    for (const it of items) {
      const row = document.createElement("li");
      row.className = "idx-row";
      const head = document.createElement("div");
      head.className = "idx-head";
      const kind = document.createElement("span");
      kind.className = "idx-kind";
      kind.textContent = it.series.label;
      const rank = document.createElement("span");
      rank.className = "idx-rank";
      rank.textContent = it.top
        ? `${it.top.tier} 段目${it.top.lap > 1 ? `（${it.top.lap} 周目）` : ""}／全 ${it.series.ranks.length} 段`
        : "まだ";
      head.append(kind, rank);
      const img = document.createElement("img");
      img.className = `idx-img${it.top ? "" : " is-locked"}`;
      img.src = `./images/index/${(it.top ?? it.first).id}.webp`;
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      row.append(head, img);
      if (it.next) {
        const next = document.createElement("p");
        next.className = "idx-next";
        next.textContent = `次の段まで ${formatRemaining(it.series.unit, it.remaining)}`;
        row.append(next);
      }
      list.append(row);
    }
    activateTab("channel");
  }
  document.getElementById("channelBack").addEventListener("click", () => activateTab("home"));

  // ポイントの収支: 貯めた量と使った量を、全体とチャンネルごとに並べて比べる
  function renderLedger() {
    const { common, commonSpent, channels } = DUMMY.points;
    const chans = DUMMY.channels;
    const earnedTotal = common + chans.reduce((s, c) => s + c.points, 0);
    const spentTotal = commonSpent + chans.reduce((s, c) => s + c.spent, 0);
    document.getElementById("ledgerEarned").textContent = `${formatCount(earnedTotal)} pt`;
    document.getElementById("ledgerSpent").textContent = `${formatCount(spentTotal)} pt`;

    const list = document.getElementById("ledgerList");
    list.replaceChildren();
    const rows = chans.filter((c) => c.points > 0 || c.spent > 0).sort((a, b) => b.points - a.points).slice(0, 8);
    const max = Math.max(...rows.map((c) => Math.max(c.points, c.spent)), 1);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "points-empty";
      empty.textContent = "まだチャンネルのポイントがありません。";
      list.append(empty);
    }
    for (const c of rows) {
      const row = document.createElement("div");
      row.className = "led-row";
      const name = document.createElement("div");
      name.className = "bd-name led-name";
      name.textContent = c.name;
      row.append(name);
      for (const [label, value, cls] of [["貯めた", c.points, "is-earned"], ["使った", c.spent, "is-spent"]]) {
        const line = document.createElement("div");
        line.className = "led-line";
        const track = document.createElement("div");
        track.className = "bd-track";
        const fill = document.createElement("div");
        fill.className = `bd-fill led-fill ${cls}`;
        fill.style.width = value > 0 ? `${Math.max(3, (value / max) * 100)}%` : "0";
        track.append(fill);
        const val = document.createElement("span");
        val.className = "bd-val";
        val.textContent = `${label} ${formatCount(value)} pt`;
        line.append(track, val);
        row.append(line);
      }
      list.append(row);
    }
  }

  // 推し歴（初めて見た日からの長さ）と、推しを増やした年表
  function renderTenure() {
    const chans = DUMMY.channels.filter((c) => c.firstWatchAt > 0).sort((a, b) => a.firstWatchAt - b.firstWatchAt);
    const list = document.getElementById("tenureList");
    const timeline = document.getElementById("timelineList");
    list.replaceChildren();
    timeline.replaceChildren();
    if (chans.length === 0) {
      const empty = document.createElement("p");
      empty.className = "points-empty";
      empty.textContent = "まだデータがありません。";
      list.append(empty);
      return;
    }
    const dayOf = (c) => Math.max(0, Math.floor((Date.now() - c.firstWatchAt) / 86_400_000));
    const max = Math.max(...chans.map(dayOf), 1);
    const fmt = (ms) => { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
    for (const c of chans) {
      const row = document.createElement("div");
      row.className = "bd-row";
      const name = document.createElement("span");
      name.className = "bd-name";
      name.textContent = c.name;
      const track = document.createElement("div");
      track.className = "bd-track";
      const fill = document.createElement("div");
      fill.className = "bd-fill";
      fill.style.width = `${Math.max(3, (dayOf(c) / max) * 100)}%`;
      track.append(fill);
      const val = document.createElement("span");
      val.className = "bd-val";
      val.textContent = `${formatCount(dayOf(c))}日`;
      row.append(name, track, val);
      list.append(row);

      const item = document.createElement("li");
      item.className = "timeline-item";
      const date = document.createElement("span");
      date.className = "timeline-date";
      date.textContent = fmt(c.firstWatchAt);
      const label = document.createElement("span");
      label.className = "timeline-name";
      label.textContent = `${c.name} を見始めた`;
      item.append(date, label);
      timeline.append(item);
    }
  }

  function renderInsights() {
    renderLedger();
    renderTenure();
  }

  // ============================================================
  // 👑 ランキング描画
  // ============================================================
  // 推しタウンと同じ「読むだけ」のサーバー関数を呼ぶ（oshitown_ranking_top / oshitown_stamp_board_info）。書き込みは一切しない
  function renderRankingMessage(text) {
    document.getElementById("rankingSubtitle").textContent = text;
    document.getElementById("rankingList").innerHTML = "";
    document.getElementById("boardList").innerHTML = "";
  }

  function renderRanking() {
    renderRankingMessage("ログインすると、ランキングと寄せ書きが見られます。");
  }

  // 寄せ書きを出す配信者の数（視聴時間の多い順。2026-10-14 依頼者決定: 上位だけにして呼び出しを減らす）
  const BOARD_CHANNELS = 5;

  // 順位バッジ: 肉球の中に順位の数字（1 位 金・2 位 銀・3 位 銅・4 位以降 薄い紫。2026-10-26 依頼者: まっすぐのぷっくり塗り）
  const RANK_PAW_COLORS = { 1: ["#ffe08a", "#f2a93b", "#4a3200"], 2: ["#e4e6ef", "#aeb3c4", "#2f3345"], 3: ["#efbb82", "#c07a3e", "#3a2100"], 0: ["#efeaff", "#c5b8f2", "#3b2f8a"] };
  const RANK_PAW_TOES = "M1.93 10.07A1.8 2.5 -22 1 0 5.27 8.73A1.8 2.5 -22 1 0 1.93 10.07zM6.32 4.96A1.9 2.6 -8 1 0 10.08 4.44A1.9 2.6 -8 1 0 6.32 4.96zM13.92 4.44A1.9 2.6 8 1 0 17.68 4.96A1.9 2.6 8 1 0 13.92 4.44zM18.73 8.73A1.8 2.5 22 1 0 22.07 10.07A1.8 2.5 22 1 0 18.73 8.73z";
  const RANK_PAW_PAD = "M12 9.2c-4.6 0-8.6 4.2-8.6 8.4 0 2.7 2 4.2 4.3 4.2 1.4 0 2.6-.8 4.3-.8s2.9.8 4.3.8c2.3 0 4.3-1.5 4.3-4.2 0-4.2-4-8.4-8.6-8.4z";
  function rankPawSvg(place, idx) {
    const [a, b, ink] = RANK_PAW_COLORS[place >= 1 && place <= 3 ? place : 0];
    const len = String(place).length;
    const size = len >= 3 ? 7 : len === 2 ? 9 : 11;
    const y = size === 11 ? 19.1 : size === 9 ? 18.7 : 18.3;
    return `<svg viewBox="0 0 24 24" width="40" height="40" role="img" aria-label="${place}位"><defs><linearGradient id="rp${idx}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><path d="${RANK_PAW_TOES}${RANK_PAW_PAD}" fill="url(#rp${idx})"/><text x="12" y="${y}" text-anchor="middle" font-size="${size}" font-weight="800" font-family="system-ui,sans-serif" fill="${ink}">${place}</text></svg>`;
  }

  function paintTown(payload) {
    const crowns = { 1: window.EmoIcons.iconSvg("crown"), 2: window.EmoIcons.iconSvg("silver"), 3: window.EmoIcons.iconSvg("bronze") };
    const rows = payload?.rows ?? [];
    const me = payload?.me ?? null;
    const boards = payload?.boards ?? [];
    document.getElementById("rankingSubtitle").textContent = rows.length
      ? `全体の視聴時間ランキング（毎日 0 時の集計）${me ? ` ／ あなたは ${Number(me.out_rank)} 位` : ""}`
      : "まだランキングに参加している人がいません。";
    document.getElementById("rankingList").innerHTML = rows.map((r, i) => {
      const place = Number(r.out_rank);
      const name = r.out_display_name || "（名前なし）";
      return `
        <li class="ranking-row${r.out_is_me ? " is-me" : ""}" data-place="${place <= 3 ? place : ""}">
          <span class="rank-badge">${rankPawSvg(place, i)}</span>
          <span class="rank-avatar" style="background:${colorFor(i)}">${esc(initialOf(name))}</span>
          <div class="rank-info">
            <div class="rank-name">
              ${crowns[place] ? `<span class="crown">${crowns[place]}</span>` : ""}
              <span>${esc(name)}</span>
              ${r.out_is_me ? `<span class="me-tag">あなた</span>` : ""}
            </div>
            <div class="rank-score">${esc(formatWatchDuration(Number(r.out_value)))}</div>
          </div>
        </li>`;
    }).join("");

    document.getElementById("boardList").innerHTML = boards.length
      ? boards.map(({ c, info }) => `
        <li class="ranking-row">
          <span class="rank-avatar" style="background:${colorFor(0)}">${esc(initialOf(c.name))}</span>
          <div class="rank-info">
            <div class="rank-name"><span>${esc(c.name)}</span></div>
            <div class="rank-score">${info
              ? `貼られたスタンプ ${Number(info.out_stamp_count ?? 0)} 枚${info.out_reached_on ? "（節目に到達）" : ` ／ 目標 ${Number(info.out_target_hours)} 時間`}`
              : "今月はまだ貼られていません"}</div>
          </div>
        </li>`).join("")
      : `<li class="ranking-row"><div class="rank-info"><div class="rank-score">視聴した配信者がまだありません。</div></div></li>`;
  }

  function showStaleTown(user) {
    const last = readStoredSnapshot(user, "town");
    if (!last) return false;
    paintTown(last.payload);
    return true;
  }

  async function loadTownData(user) {
    const gen = authGen;
    renderRankingMessage("読み込み中…");
    try {
      const got = await onceADay(user, "town", async () => {
        const [topRes, meRes] = await Promise.all([
          supabase.rpc("oshitown_ranking_top", { p_scope: "all", p_channel_id: null, p_metric: "watch", p_limit: 50 }),
          supabase.rpc("oshitown_ranking_my_rank", { p_scope: "all", p_channel_id: null, p_metric: "watch" }),
        ]);
        // 一部だけ失敗した結果を 1 日分の控えに残さない（その日ずっと「順位なし」「まだ貼られていません」になるため）。全部そろった時だけ控える
        if (topRes.error) throw topRes.error;
        if (meRes.error) throw meRes.error;
        const channels = (DUMMY.channels ?? []).filter((c) => c.id)
          .sort((a, b) => b.watchMs - a.watchMs).slice(0, BOARD_CHANNELS);
        const boards = await Promise.all(channels.map(async (c) => {
          const { data, error } = await supabase.rpc("oshitown_stamp_board_info", { p_channel_id: c.id, p_month: null });
          if (error) throw error;
          return { c: { id: c.id, name: c.name }, info: (data ?? [])[0] ?? null };
        }));
        return { rows: topRes.data ?? [], me: (meRes.data ?? [])[0] ?? null, boards };
      });
      if (!got) return; // 通信の間にログアウトした（画面は showLoggedOut が片付け済み）
      paintTown(got.payload);
    } catch (err) {
      console.warn("[EmoChat] ランキングを取得できませんでした", err);
      if (gen !== authGen) return; // 通信の間にログアウト・別の人に替わった
      if (showStaleTown(user)) return; // 通信できない時は、前回のランキングを出す（2026-10-19）
      renderRankingMessage("取得できませんでした。しばらくしてからもう一度お試しください。");
    }
  }

  // ============================================================
  // 📊 ログ＆グラフ描画
  // ============================================================
  function renderLog() {
    renderHeatmap();
    renderLogKinds();
  }

  // ---- 推し活ヒートマップ（直近 90 日。GitHub の草グラフと同じ、日曜始まり・週が列のレイアウト） ----
  //   マスの並びは CSS の grid-auto-flow: column に任せる（7 行ぶん埋めたら次の列へ）ので、
  //   ここでは「1 週目の頭を日曜に揃えるための空マス → 90 日ぶんのマス」を順番に並べるだけでよい
  function heatmapLevel(watchMs, maxWatchMs) {
    if (watchMs <= 0 || maxWatchMs <= 0) return 0;
    // 一番多い日を 6 に、記録のある日を 1〜6 の 6 段に等分する（2026-10-25 依頼者: 7 段階 = 記録なし + 6 段）
    return Math.min(6, Math.max(1, Math.ceil((watchMs / maxWatchMs) * 6)));
  }

  function renderHeatmap() {
    const grid = document.getElementById("heatmapGrid");
    const history = DUMMY.dailyHistory ?? [];
    const byDate = new Map(history.map((e) => [e.date, e]));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (HEATMAP_DAYS - 1));
    const leadingEmpty = start.getDay(); // 日曜 = 0。その週の頭に揃えるための空マスの数

    const maxWatchMs = Math.max(0, ...history.map((e) => e.watchMs));

    const cells = Array.from({ length: leadingEmpty }, () => null);
    for (let i = 0; i < HEATMAP_DAYS; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const date = localDateString(d.getTime());
      cells.push(byDate.get(date) ?? { date, watchMs: 0, feverCount: 0 });
    }

    grid.innerHTML = cells
      .map((entry) => {
        if (!entry) return `<span class="heatmap-cell is-empty" aria-hidden="true"></span>`;
        const level = heatmapLevel(entry.watchMs, maxWatchMs);
        return `
        <button type="button" class="heatmap-cell" data-level="${level}" data-date="${entry.date}"
          data-watch="${entry.watchMs}" data-fever="${entry.feverCount}" aria-label="${entry.date}"></button>`;
      })
      .join("");

    grid.querySelectorAll(".heatmap-cell:not(.is-empty)").forEach((cell) => {
      cell.addEventListener("click", () => {
        showHeatmapDetail(cell.dataset);
        focusLogDay(cell.dataset.date);
      });
      cell.addEventListener("mouseenter", () => showHeatmapDetail(cell.dataset));
    });

    const latest = [...cells].reverse().find(Boolean); // 一番新しい日を初期表示にする
    if (latest) showHeatmapDetail({ date: latest.date, watch: String(latest.watchMs), fever: String(latest.feverCount) });
  }

  function showHeatmapDetail({ date, watch, fever }) {
    document.getElementById("heatmapDetailDate").textContent = date;
    document.getElementById("heatmapDetailWatch").textContent = `視聴時間: ${formatWatchDuration(Number(watch))}`;
    document.getElementById("heatmapDetailFever").textContent = `激熱回数: ${formatCount(Number(fever))}回`;
    document.querySelectorAll(".heatmap-cell.is-selected").forEach((el) => el.classList.remove("is-selected"));
    const target = document.querySelector(`.heatmap-cell[data-date="${date}"]`);
    if (target) target.classList.add("is-selected");
  }

  // 取り込んだ日別（新しい日が先）。日付の形が違う行は出さない
  function activityNewestFirst() {
    return (DUMMY.activity ?? [])
      .filter((row) => typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  function formatLogDate(date) {
    return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  }

  function formatYearMonth(ym) {
    return `${Number(ym.slice(0, 4))}年${Number(ym.slice(5, 7))}月`;
  }

  // 2026-01 の前は 2025-12（月の index が負になっても Date が年を繰り下げる）
  function previousMonthKey(ym) {
    const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function formatDelta(diff, kind) {
    if (diff === 0) return "±0";
    const sign = diff > 0 ? "＋" : "−";
    const abs = Math.abs(diff);
    if (kind === "watch") return `${sign}${formatWatchDuration(abs)}`;
    if (kind === "points") return `${sign}${formatCount(abs)} pt`;
    return `${sign}${formatCount(abs)}`;
  }

  function sumActivity(rows) {
    return rows.reduce((acc, row) => ({
      watchMs: acc.watchMs + row.watchMs,
      commentCount: acc.commentCount + row.commentCount,
      feverCount: acc.feverCount + row.feverCount,
      channelPoints: acc.channelPoints + row.channelPoints,
    }), { watchMs: 0, commentCount: 0, feverCount: 0, channelPoints: 0 });
  }

  // 同じ値なら日付が新しい方。0 以下は記録にしない
  function bestBy(rows, key) {
    let best = null;
    for (const row of rows) {
      const value = row[key];
      if (!(value > 0)) continue;
      if (!best || value > best[key] || (value === best[key] && row.date > best.date)) best = row;
    }
    return best;
  }

  function logText(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    window.EmoIcons.setIconText(el, text); // 絵文字は SVG アイコンにする（2026-10-25）
    return el;
  }

  function logLine(className, text, field) {
    const el = logText("p", className, text);
    if (field) el.dataset.field = field;
    return el;
  }

  function renderLogDaily() {
    const list = document.getElementById("logDailyList");
    const more = document.getElementById("logDailyMore");
    list.replaceChildren();
    if (!statsSignedIn) {
      more.hidden = true;
      list.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const rows = activityNewestFirst();
    if (!rows.length) {
      more.hidden = true;
      list.append(logText("p", "points-empty", "まだ日ごとの記録がありません。"));
      return;
    }
    // 表の見出しは 1 回だけ。各日は数字だけで、0 は「–」（2026-10-27 依頼者が案 D を採用）
    const head = document.createElement("div");
    head.className = "log-day-head";
    for (const t of ["日", "視聴", "コメ", "激熱", "pt"]) head.append(logText("span", "", t));
    list.append(head);
    const thisYear = new Date().getFullYear();
    const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
    const shortDate = (date) => {
      const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
      return y === thisYear ? `${m}/${d}(${WEEK[new Date(y, m - 1, d).getDay()]})` : `${y}/${m}/${d}`;
    };
    const cell = (cls, n, text) => logText("span", `log-day-stat ${cls}`, n > 0 ? text : "–");
    for (const row of rows.slice(0, logDailyShown)) {
      const item = document.createElement("div");
      item.className = "log-day";
      item.dataset.date = row.date;
      const quiet = !(row.watchMs > 0 || row.commentCount > 0 || row.feverCount > 0 || row.infernoCount > 0 || row.channelPoints > 0);
      if (quiet) item.classList.add("is-quiet");
      const fever = cell("log-day-fever", row.feverCount, formatCount(row.feverCount));
      if (row.infernoCount > 0) fever.append(logText("small", "log-day-inferno", `爆熱${formatCount(row.infernoCount)}`));
      item.append(
        logText("div", "log-day-date", shortDate(row.date)),
        cell("log-day-watch", row.watchMs, formatWatchDuration(row.watchMs)),
        cell("log-day-comments", row.commentCount, formatCount(row.commentCount)),
        fever,
        cell("log-day-points", row.channelPoints, formatCount(row.channelPoints)),
      );
      list.append(item);
    }
    more.hidden = logDailyShown >= rows.length;
  }

  function monthTotals(which, ym, rows) {
    const box = document.createElement("div");
    box.className = "log-month";
    box.dataset.month = ym;
    box.append(logText("h4", "log-month-title", `${which}（${formatYearMonth(ym)}）`));
    const sum = sumActivity(rows);
    const best = bestBy(rows, "watchMs");
    const bestLine = logLine("log-month-line", "", "best");
    if (best) {
      bestLine.append(
        document.createTextNode("いちばん長く見た日: "),
        logText("span", "log-keep", `${formatLogDate(best.date)}（${formatWatchDuration(best.watchMs)}）`),
      );
    } else {
      bestLine.textContent = "いちばん長く見た日: まだありません";
    }
    box.append(
      logLine("log-month-line", `視聴時間 ${formatWatchDuration(sum.watchMs)}`, "watch"),
      logLine("log-month-line", `コメント ${formatCount(sum.commentCount)}`, "comments"),
      logLine("log-month-line", `激熱 ${formatCount(sum.feverCount)}回`, "fever"),
      logLine("log-month-line", `ポイント ${formatCount(sum.channelPoints)} pt`, "points"),
      bestLine,
    );
    return box;
  }

  function renderLogMonth() {
    const body = document.getElementById("logMonthBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const rows = activityNewestFirst();
    const thisYm = localDateString(Date.now()).slice(0, 7);
    const lastYm = previousMonthKey(thisYm);
    const thisRows = rows.filter((row) => row.date.slice(0, 7) === thisYm);
    const lastRows = rows.filter((row) => row.date.slice(0, 7) === lastYm);
    body.append(monthTotals("今月", thisYm, thisRows));
    if (!lastRows.length) {
      const box = document.createElement("div");
      box.className = "log-month";
      box.dataset.month = lastYm;
      box.append(
        logText("h4", "log-month-title", `先月（${formatYearMonth(lastYm)}）`),
        logText("p", "log-month-empty", "先月の記録はありません"),
      );
      body.append(box);
      return;
    }
    body.append(monthTotals("先月", lastYm, lastRows));
    const cur = sumActivity(thisRows);
    const prev = sumActivity(lastRows);
    const delta = document.createElement("div");
    delta.className = "log-month-delta";
    delta.append(
      logLine("log-month-line", `視聴時間の差 ${formatDelta(cur.watchMs - prev.watchMs, "watch")}`, "delta-watch"),
      logLine("log-month-line", `コメントの差 ${formatDelta(cur.commentCount - prev.commentCount, "count")}`, "delta-comments"),
      logLine("log-month-line", `激熱の差 ${formatDelta(cur.feverCount - prev.feverCount, "count")}`, "delta-fever"),
      logLine("log-month-line", `ポイントの差 ${formatDelta(cur.channelPoints - prev.channelPoints, "points")}`, "delta-points"),
    );
    body.append(delta);
  }

  // チャンネルの表に「最後に見た日」は無い（first_watch_at は最初に見た日、updated_at は行の更新時刻）。
  //   その項目は出さない。並びはホームの一覧と同じ、視聴時間が長い順
  function renderLogChannels() {
    const list = document.getElementById("logChannelList");
    list.replaceChildren();
    if (!statsSignedIn) {
      const li = document.createElement("li");
      li.className = "points-empty log-signed-out";
      li.textContent = LOG_SIGNED_OUT;
      list.append(li);
      return;
    }
    const channels = [...DUMMY.channels].sort((a, b) => b.watchMs - a.watchMs || String(a.name).localeCompare(String(b.name), "ja"));
    if (!channels.length) {
      const li = document.createElement("li");
      li.className = "points-empty";
      li.textContent = "まだチャンネルの記録がありません。";
      list.append(li);
      return;
    }
    channels.forEach((ch, i) => {
      const row = document.createElement("li");
      row.className = "points-channel-row is-link log-channel-row";
      const text = document.createElement("span");
      text.className = "log-channel-text";
      const name = document.createElement("span");
      name.className = "points-channel-name";
      name.textContent = ch.name; // 配信者名は外部由来なので textContent（innerHTML に入れない）
      const meta = document.createElement("span");
      meta.className = "log-channel-meta";
      meta.append(
        logText("span", "log-keep", `視聴 ${formatWatchDuration(ch.watchMs)}`),
        document.createTextNode("・"),
        logText("span", "log-keep", `コメント ${formatCount(ch.comments)}`),
        document.createTextNode("・"),
        logText("span", "log-keep", `激熱 ${formatCount(ch.fever)}回`),
      );
      text.append(name, meta);
      row.append(channelAvatarEl(ch, i, "points-channel-avatar"), text);
      row.addEventListener("click", () => openChannel(ch, i));
      list.append(row);
    });
  }

  function renderLogRecords() {
    const body = document.getElementById("logRecordBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const rows = activityNewestFirst();
    const watchBest = bestBy(rows, "watchMs");
    const commentBest = bestBy(rows, "commentCount");
    const feverBest = bestBy(rows, "feverCount");
    const infernoBest = bestBy(rows, "infernoCount");
    const specs = [
      ["watch", "1日の最長視聴時間", watchBest ? `${formatWatchDuration(watchBest.watchMs)}（${formatLogDate(watchBest.date)}）` : ""],
      ["comments", "1日の最多コメント", commentBest ? `${formatCount(commentBest.commentCount)}（${formatLogDate(commentBest.date)}）` : ""],
      ["fever", "1日の最多激熱", feverBest ? `${formatCount(feverBest.feverCount)}回（${formatLogDate(feverBest.date)}）` : ""],
      ["inferno", "1日の最多爆熱", infernoBest ? `${formatCount(infernoBest.infernoCount)}回（${formatLogDate(infernoBest.date)}）` : ""],
    ];
    for (const [kind, label, value] of specs) {
      const line = document.createElement("p");
      line.className = "log-record";
      line.dataset.kind = kind;
      if (value) {
        line.append(document.createTextNode(`${label}: `), logText("span", "log-keep", value));
      } else {
        line.textContent = `${label}: まだありません`;
      }
      body.append(line);
    }
    // 連続日数の自己ベストは、すでに computeStreak が longest を出している
    const streak = logText("p", "log-record", `連続日数の自己ベスト: ${formatCount(DUMMY.streak.longest)}日`);
    streak.dataset.kind = "streak";
    body.append(streak);
  }

  // ログ: 曜日
  // 記録のある日だけを曜日に分ける（記録の無い日は 0 として平均に入れない）。横棒は、その曜日の平均 ÷ いちばん長い平均。
  function renderLogWeekday() {
    const body = document.getElementById("logWeekdayBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const rows = activityNewestFirst();
    if (!rows.length) {
      body.append(logText("p", "points-empty", "まだ曜日の記録がありません"));
      return;
    }
    const buckets = Array.from({ length: 7 }, () => ({ watchMs: 0, commentCount: 0, count: 0 }));
    const seen = new Map();
    for (const row of rows) {
      const cur = seen.get(row.date) ?? { watchMs: 0, commentCount: 0 };
      cur.watchMs += row.watchMs;
      cur.commentCount += row.commentCount;
      seen.set(row.date, cur);
    }
    for (const [date, row] of seen) {
      const y = Number(date.slice(0, 4));
      const m = Number(date.slice(5, 7));
      const d = Number(date.slice(8, 10));
      const dow = new Date(y, m - 1, d).getDay();
      const bucket = buckets[dow];
      bucket.watchMs += Math.max(0, row.watchMs);
      bucket.commentCount += Math.max(0, row.commentCount);
      bucket.count += 1;
    }
    const labels = ["日", "月", "火", "水", "木", "金", "土"];
    const names = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
    const order = [1, 2, 3, 4, 5, 6, 0];
    const avgOf = (bucket) => (bucket.count ? { watch: bucket.watchMs / bucket.count, comments: bucket.commentCount / bucket.count } : null);
    let maxWatch = 0;
    let maxComments = 0;
    for (const dow of order) {
      const avg = avgOf(buckets[dow]);
      if (!avg) continue;
      if (avg.watch > maxWatch) maxWatch = avg.watch;
      if (avg.comments > maxComments) maxComments = avg.comments;
    }
    const formatAvg = (n) => {
      const rounded = Math.round(n * 10) / 10;
      if (Number.isInteger(rounded)) return formatCount(rounded);
      return rounded.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    };
    const bar = (pct, comments) => {
      const track = document.createElement("div");
      track.className = "log-weekday-track";
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("div");
      fill.className = comments ? "log-weekday-bar is-comments" : "log-weekday-bar";
      fill.style.width = `${pct}%`;
      track.append(fill);
      return track;
    };
    let best = null;
    for (const dow of order) {
      const avg = avgOf(buckets[dow]);
      const box = document.createElement("div");
      box.className = "log-weekday";
      box.dataset.weekday = String(dow);
      box.append(logText("p", "log-weekday-label", labels[dow]));
      if (!avg) {
        const empty = logText("p", "log-weekday-avg", "記録なし");
        empty.dataset.kind = "empty";
        box.append(empty);
      } else {
        const watchText = logText("p", "log-weekday-avg", `視聴の平均 ${formatWatchDuration(avg.watch)}`);
        watchText.dataset.kind = "watch";
        const commentText = logText("p", "log-weekday-avg", `コメントの平均 ${formatAvg(avg.comments)}`);
        commentText.dataset.kind = "comments";
        const watchPct = maxWatch > 0 ? Math.round((avg.watch / maxWatch) * 100) : 0;
        const commentPct = maxComments > 0 ? Math.round((avg.comments / maxComments) * 100) : 0;
        box.append(watchText, bar(watchPct, false), commentText, bar(commentPct, true));
        if (!best || avg.watch > best.watch || (avg.watch === best.watch && avg.comments > best.comments)) {
          best = { dow, watch: avg.watch, comments: avg.comments };
        }
      }
      body.append(box);
    }
    if (best) {
      const most = logText("p", "log-weekday-most", `いちばん多い曜日: ${names[best.dow]}（視聴の平均 ${formatWatchDuration(best.watch)}）`);
      most.dataset.field = "most";
      body.append(most);
    }
  }
  // /ログ: 曜日

  // ログ: 週
  // 月曜はじまり。引数の日付文字列は端末の暦日（YYYY-MM-DD）。UTC の日付にはしない。
  function logWeekStartMonday(date) {
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    const dt = new Date(y, m - 1, d);
    const back = dt.getDay() === 0 ? 6 : dt.getDay() - 1;
    dt.setDate(dt.getDate() - back);
    const pad2 = (n) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  function logAddDays(date, days) {
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    const dt = new Date(y, m - 1, d + days);
    const pad2 = (n) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  function renderLogWeek() {
    const body = document.getElementById("logWeekBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const rows = activityNewestFirst();
    const thisMonday = logWeekStartMonday(localDateString(Date.now()));
    const starts = [];
    for (let i = 0; i < 8; i++) starts.push(logAddDays(thisMonday, -7 * i));
    const sumBetween = (start, end) => {
      const sum = { watchMs: 0, commentCount: 0, feverCount: 0 };
      for (const row of rows) {
        if (row.date < start || row.date >= end) continue;
        sum.watchMs += Math.max(0, row.watchMs);
        sum.commentCount += Math.max(0, row.commentCount);
        sum.feverCount += Math.max(0, row.feverCount);
      }
      return sum;
    };
    const sums = starts.map((start) => sumBetween(start, logAddDays(start, 7)));
    sums.forEach((sum, i) => {
      const line = logText(
        "p",
        "log-week-line",
        `${formatLogDate(starts[i])}の週: 視聴 ${formatWatchDuration(sum.watchMs)}・コメント ${formatCount(sum.commentCount)}・激熱 ${formatCount(sum.feverCount)}回`,
      );
      line.dataset.week = starts[i];
      body.append(line);
    });
    const cur = sums[0];
    const prev = sums[1];
    const delta = logText(
      "p",
      "log-week-delta",
      `先週との差: 視聴 ${formatDelta(cur.watchMs - prev.watchMs, "watch")}・コメント ${formatDelta(cur.commentCount - prev.commentCount, "count")}・激熱 ${formatDelta(cur.feverCount - prev.feverCount, "count")}`,
    );
    delta.dataset.field = "delta";
    body.append(delta);
  }
  // /ログ: 週

  // ログ: 激熱TOP
  function renderLogFeverTop() {
    const body = document.getElementById("logFeverTopBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const byDate = new Map();
    for (const row of activityNewestFirst()) {
      const cur = byDate.get(row.date) ?? { date: row.date, feverCount: 0 };
      cur.feverCount += Math.max(0, row.feverCount);
      byDate.set(row.date, cur);
    }
    const ranked = [...byDate.values()]
      .filter((row) => row.feverCount > 0)
      .sort((a, b) => b.feverCount - a.feverCount || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, 5);
    if (!ranked.length) {
      body.append(logText("p", "points-empty", "まだ激熱の記録はありません"));
      return;
    }
    ranked.forEach((row, i) => {
      const line = logText("p", "log-fever-line", `${i + 1}. ${formatLogDate(row.date)}（${formatCount(row.feverCount)}回）`);
      line.dataset.rank = String(i + 1);
      line.dataset.date = row.date;
      body.append(line);
    });
  }
  // /ログ: 激熱TOP

  // ログ: マイルストーン
  // 区切りは、その日の終わりの累計が初めてその値以上になった日。次の区切りまでは、いまの累計との差。
  // チャンネルの累計より日別の合計が 1 分以上短い時は、古い日が取り込み範囲の外なので、超えた日は出さない。
  function renderLogMilestone() {
    const body = document.getElementById("logMilestoneBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const byDate = new Map();
    for (const row of activityNewestFirst()) {
      const cur = byDate.get(row.date) ?? { date: row.date, watchMs: 0, commentCount: 0, feverCount: 0 };
      cur.watchMs += Math.max(0, row.watchMs);
      cur.commentCount += Math.max(0, row.commentCount);
      cur.feverCount += Math.max(0, row.feverCount);
      byDate.set(row.date, cur);
    }
    const ordered = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const daily = { watchMs: 0, commentCount: 0, feverCount: 0 };
    for (const row of ordered) {
      daily.watchMs += row.watchMs;
      daily.commentCount += row.commentCount;
      daily.feverCount += row.feverCount;
    }
    const life = { watchMs: 0, commentCount: 0, feverCount: 0 };
    for (const ch of DUMMY.channels) {
      life.watchMs += Math.max(0, ch.watchMs);
      life.commentCount += Math.max(0, ch.comments);
      life.feverCount += Math.max(0, ch.fever);
    }
    const milestones = [
      {
        metric: "watch",
        marks: [10, 50, 100, 500, 1000],
        lifeTotal: life.watchMs,
        dailyTotal: daily.watchMs,
        slack: 60_000,
        rowValue: (row) => row.watchMs,
        markValue: (mark) => mark * 3_600_000,
        title: "⏱️ 視聴時間",
        markText: (mark) => `${formatCount(mark)}時間`,
        totalText: (v) => formatWatchDuration(v),
        remainText: (v) => formatWatchDuration(v),
      },
      {
        metric: "comments",
        marks: [100, 1000, 5000],
        lifeTotal: life.commentCount,
        dailyTotal: daily.commentCount,
        slack: 0,
        rowValue: (row) => row.commentCount,
        markValue: (mark) => mark,
        title: "💬 コメント",
        markText: (mark) => `${formatCount(mark)}件`,
        totalText: (v) => `${formatCount(v)}件`,
        remainText: (v) => `${formatCount(v)}件`,
      },
      {
        metric: "fever",
        marks: [10, 100, 500],
        lifeTotal: life.feverCount,
        dailyTotal: daily.feverCount,
        slack: 0,
        rowValue: (row) => row.feverCount,
        markValue: (mark) => mark,
        title: "🔥 激熱",
        markText: (mark) => `${formatCount(mark)}回`,
        totalText: (v) => `${formatCount(v)}回`,
        remainText: (v) => `${formatCount(v)}回`,
      },
    ];
    for (const spec of milestones) {
      const box = document.createElement("div");
      box.dataset.metric = spec.metric;
      const hits = new Map();
      let run = 0;
      for (const row of ordered) {
        run += spec.rowValue(row);
        for (const mark of spec.marks) {
          if (!hits.has(mark) && run >= spec.markValue(mark)) hits.set(mark, row.date);
        }
      }
      const complete = spec.lifeTotal <= spec.dailyTotal + spec.slack;
      const total = complete ? spec.dailyTotal : spec.lifeTotal;
      const next = spec.marks.find((mark) => total < spec.markValue(mark));
      const prevMark = [...spec.marks].reverse().find((mark) => total >= spec.markValue(mark));
      const head = document.createElement("div");
      head.className = "log-ms-head";
      head.append(logText("span", "log-ms-title", spec.title), logText("span", "log-ms-total", spec.totalText(total)));
      box.append(head);
      // 次の区切りまでの進み具合（前の区切りから次の区切りまでを 100% として）
      if (next != null) {
        const from = prevMark == null ? 0 : spec.markValue(prevMark);
        const to = spec.markValue(next);
        const track = document.createElement("div");
        track.className = "log-ms-track";
        const fill = document.createElement("div");
        fill.className = "log-ms-fill";
        fill.style.width = `${Math.max(2, Math.min(100, Math.round(((total - from) / (to - from)) * 100)))}%`;
        track.append(fill);
        box.append(track);
      }
      const nextLine = document.createElement("p");
      nextLine.className = "log-milestone-next";
      if (next == null) {
        nextLine.textContent = "すべての区切りを達成しました";
        nextLine.dataset.next = "none";
      } else {
        nextLine.textContent = `次の目標 ${spec.markText(next)} まで、あと ${spec.remainText(spec.markValue(next) - total)}`;
        nextLine.dataset.next = String(next);
      }
      box.append(nextLine);
      // 超えた区切り（日付が分かるものは日付つき。古すぎて分からないものは日付なし）
      const chips = document.createElement("div");
      chips.className = "log-ms-chips";
      for (const mark of spec.marks) {
        if (total < spec.markValue(mark)) continue;
        const date = complete && hits.has(mark) ? ` ${formatLogDate(hits.get(mark))}` : "";
        const chip = logText("span", "log-ms-chip", `✓ ${spec.markText(mark)}${date}`);
        chip.dataset.mark = String(mark);
        chips.append(chip);
      }
      if (chips.childNodes.length) box.append(chips);
      body.append(box);
    }
  }
  // /ログ: マイルストーン

  // ログ: 推し歴
  function logHistoryAgo(thenMs, nowMs) {
    const then = new Date(thenMs);
    const now = new Date(nowMs);
    let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
    if (now.getDate() < then.getDate()) months -= 1;
    if (months < 0) months = 0;
    const years = Math.floor(months / 12);
    const rest = months % 12;
    return `${years}年${rest}か月前`;
  }

  function renderLogHistory() {
    const body = document.getElementById("logHistoryBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const rows = DUMMY.channels
      .filter((ch) => ch.firstWatchAt > 0)
      .sort((a, b) => a.firstWatchAt - b.firstWatchAt || String(a.name).localeCompare(String(b.name), "ja"));
    if (!rows.length) {
      body.append(logText("p", "points-empty", "まだ推し歴の記録はありません"));
      return;
    }
    const list = document.createElement("ul");
    list.className = "points-channel-list";
    const now = Date.now();
    for (const ch of rows) {
      const item = document.createElement("li");
      item.className = "log-history-row";
      item.dataset.channel = ch.id;
      const name = document.createElement("span");
      name.className = "log-history-name";
      name.textContent = ch.name;
      const when = document.createElement("span");
      when.className = "log-history-when";
      when.textContent = `${formatLogDate(localDateString(ch.firstWatchAt))}（${logHistoryAgo(ch.firstWatchAt, now)}）`;
      item.append(name, when);
      list.append(item);
    }
    body.append(list);
  }
  // /ログ: 推し歴

  // ログ: 応援
  function renderLogCheer() {
    const body = document.getElementById("logCheerBody");
    body.replaceChildren();
    if (!statsSignedIn) {
      body.append(logText("p", "points-empty log-signed-out", LOG_SIGNED_OUT));
      return;
    }
    const rows = DUMMY.channels
      .filter((ch) => ch.cheer > 0 || ch.spent > 0)
      .sort((a, b) => b.cheer - a.cheer || b.spent - a.spent || String(a.name).localeCompare(String(b.name), "ja"));
    if (!rows.length) {
      body.append(logText("p", "points-empty", "まだ応援の記録はありません"));
      return;
    }
    const list = document.createElement("ul");
    list.className = "points-channel-list";
    let cheer = 0;
    let spent = 0;
    for (const ch of rows) {
      cheer += ch.cheer;
      spent += ch.spent;
      const item = document.createElement("li");
      item.className = "log-cheer-row";
      item.dataset.channel = ch.id;
      const name = document.createElement("span");
      name.className = "log-cheer-name";
      name.textContent = ch.name;
      const meta = document.createElement("span");
      meta.className = "log-cheer-meta";
      meta.textContent = `応援 ${formatCount(ch.cheer)}回・使ったポイント ${formatCount(ch.spent)}`;
      item.append(name, meta);
      list.append(item);
    }
    const total = logText("p", "log-cheer-total", `合計: 応援 ${formatCount(cheer)}回・使ったポイント ${formatCount(spent)}`);
    total.dataset.field = "total";
    body.append(list, total);
  }
  // /ログ: 応援

  function renderLogKinds() {
    renderLogDaily();
    renderLogMonth();
    renderLogChannels();
    renderLogRecords();
    renderLogWeekday();
    renderLogWeek();
    renderLogFeverTop();
    renderLogMilestone();
    renderLogHistory();
    renderLogCheer();
  }

  // ログのカードを折りたたみにする（最初は閉じている。ヒートマップのカードは開いたまま。2026-10-24）
  //   見出しを押すと、高さがなめらかに広がる。中身の要素は移すだけなので、ID も描く関数もそのまま
  const LOG_FOLD_CARDS = ["logDailyCard", "logMonthCard", "logChannelCard", "logRecordCard", "logWeekdayCard", "logWeekCard", "logFeverTopCard", "logMilestoneCard", "logHistoryCard", "logCheerCard"];
  function setLogFold(card, open) {
    if (!card) return;
    card.classList.toggle("is-open", open);
    card.querySelector(".log-fold-head")?.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function setupLogFolds() {
    LOG_FOLD_CARDS.forEach((id, i) => {
      const card = document.getElementById(id);
      const head = card?.querySelector(".card-section-head");
      if (!card || !head || card.classList.contains("log-fold")) return;
      const body = document.createElement("div");
      body.className = "log-fold-body";
      body.id = `${id}Fold`;
      const inner = document.createElement("div");
      inner.className = "log-fold-inner";
      while (head.nextSibling) inner.appendChild(head.nextSibling);
      body.appendChild(inner);
      head.after(body);
      head.classList.add("log-fold-head");
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-controls", body.id);
      const chev = document.createElement("i");
      chev.className = "log-fold-chev";
      chev.setAttribute("aria-hidden", "true");
      head.appendChild(chev);
      card.classList.add("log-fold");
      setLogFold(card, false);
      const toggle = () => setLogFold(card, !card.classList.contains("is-open"));
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  // ヒートマップのマスをタップした日が、見えている 14 日より古ければそこまで開いてから光らせる
  function focusLogDay(date) {
    if (!statsSignedIn || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const rows = activityNewestFirst();
    const index = rows.findIndex((row) => row.date === date);
    if (index < 0) return;
    if (index >= logDailyShown) {
      logDailyShown = Math.min(rows.length, Math.ceil((index + 1) / LOG_DAILY_PAGE) * LOG_DAILY_PAGE);
      renderLogDaily();
    }
    setLogFold(document.getElementById("logDailyCard"), true); // 閉じていたら開いてから光らせる
    const row = document.querySelector(`#logDailyList .log-day[data-date="${date}"]`);
    if (!row) return;
    document.querySelectorAll("#logDailyList .log-day.is-flash").forEach((el) => el.classList.remove("is-flash"));
    if (typeof row.scrollIntoView === "function") {
      try { row.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { /* テスト用の DOM では動かないことがある */ }
    }
    row.classList.remove("is-flash");
    void row.offsetWidth;
    row.classList.add("is-flash");
  }

  function setupLogKinds() {
    document.getElementById("logDailyMore").addEventListener("click", () => {
      logDailyShown += LOG_DAILY_PAGE;
      renderLogDaily();
    });
  }

  // ============================================================
  // ⚙️ 設定描画
  // ============================================================
  // 表示名・ランキング参加は「見るだけ」（この版は閲覧専用。変更は拡張機能の設定ページで）
  function renderSettingsProfile() {
    document.getElementById("displayNameInput").value = DUMMY.profile.displayName;
    document.getElementById("rankingOptInToggle").checked = DUMMY.profile.rankingOptIn;
  }

  function renderSettings() {
    renderSettingsProfile();

    const planBadge = document.getElementById("planBadge");
    const upgradeBtn = document.getElementById("upgradeBtn");
    function renderPlan() {
      planBadge.dataset.plan = DUMMY.plan;
      planBadge.textContent = DUMMY.plan === "premium" ? "プレミアム版" : "無料プラン";
      upgradeBtn.hidden = DUMMY.plan === "premium";
    }
    renderPlan();

    upgradeBtn.addEventListener("click", () => {
      DUMMY.plan = "premium";
      renderPlan();
    });

    // 見た目は「明るいラベンダー」の 1 つだけ（2026-10-14 依頼者決定: テーマの選択は無し。端末のダークモードにも追従しない）
    document.documentElement.dataset.theme = "light";
  }

  // ============================================================
  // 認証UIの配線（Google ログイン・ログアウト・ログイン状態の監視）
  // ============================================================
  function setupAuth() {
    const loggedOutBox = document.getElementById("authLoggedOut");
    const loggedInBox = document.getElementById("authLoggedIn");
    const emailEl = document.getElementById("authUserEmail");
    const loginStatus = document.getElementById("loginStatus");
    const googleBtn = document.getElementById("googleLoginBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const retryBtn = document.getElementById("authRetryBtn");

    // mode: "loading" | "error" | undefined（通常の表示）
    function setStatus(text, mode) {
      loginStatus.textContent = text;
      loginStatus.classList.toggle("is-loading", mode === "loading");
      loginStatus.classList.toggle("is-error", mode === "error");
      retryBtn.hidden = mode !== "error";
    }

    let currentUid = null; // 今画面に出している人（null = 未ログイン）
    let currentUser = null;
    let seenDay = localDateString(Date.now()); // 見えている間に日付が変わったら、1 回だけ取り直す（2026-10-19）
    function applyAuthState(session) {
      const user = session?.user ?? null;
      const uid = user?.id ?? null;
      if (uid && uid === currentUid) return; // 同じ人のまま（トークンの更新など）。取り直さない
      if (uid && currentUid && uid !== currentUid) clearSnapshots(); // 別の人に替わった時だけ、前の人の控えを消す（2026-10-19）
      currentUid = uid;
      currentUser = user;
      authGen++; // 走っている途中の通信の結果は捨てる（onceADay）
      loggedOutBox.hidden = !!user;
      loggedInBox.hidden = !user;
      if (user) {
        showLoggedOut(); // 別の人に替わった時も、前の人の数字を取得が終わるまで残さない（先に空にしてから取りに行く）
        emailEl.textContent = user.email ?? "";
        setStatus("ログイン中");
        loadRealStats(user);
      } else {
        emailEl.textContent = "";
        setStatus("未ログイン");
        showLoggedOut(); // ログアウト後も前の人の数字が画面に残らないように（2026-10-15 第三者レビューの指摘）
        hideLoadingScreen();
      }
    }

    googleBtn.addEventListener("click", async () => {
      setStatus("Googleへ移動しています…", "loading");
      try {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: window.location.origin + window.location.pathname },
        });
        if (error) throw error;
        // 成功時はここでページごと Google へ遷移するので、これ以降は戻ってこない
      } catch (err) {
        console.warn("[EmoChat] ログインを開始できませんでした", err);
        setStatus("ログインを開始できませんでした。もう一度お試しください", "error");
      }
    });

    logoutBtn.addEventListener("click", async () => {
      setStatus("ログアウトしています…", "loading");
      try {
        clearSnapshots(); // 端末に控えた記録を先に消す（共用の端末で次の人に見えないように）
        // scope: "local" = このブラウザだけログアウト。省略すると全端末（パソコンの拡張機能も）切れてしまう（2026-10-15）
        const { error } = await supabase.auth.signOut({ scope: "local" });
        if (error) throw error;
      } catch (err) {
        console.warn("[EmoChat] ログアウトに失敗しました", err);
        setStatus("ログアウトに失敗しました。もう一度お試しください", "error");
      }
    });

    retryBtn.addEventListener("click", async () => {
      setStatus("認証状態を確認中…", "loading");
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        applyAuthState(data.session);
      } catch (err) {
        console.warn("[EmoChat] 認証状態を確認できませんでした", err);
        setStatus("通信に失敗しました。もう一度お試しください", "error");
      }
    });

    // 初回の呼び出しで、今の（復元できた）ログイン状態がすぐに届く（supabase-js v2 の仕様）
    supabase.auth.onAuthStateChange((event, session) => {
      // 控えを消すのはログアウトの通知だけ。開いた直後の「セッション無し」では消さない（翌日オフラインできのうの画面を残す。2026-10-19）
      if (event === "SIGNED_OUT") {
        if (!session) clearSnapshots();
      }
      applyAuthState(session);
    });

    // タブに戻った時と、戻る操作でページが再び出た時。同じ日は 1 回だけ（2026-10-19）
    const onSeenAgain = () => {
      if (document.visibilityState !== "visible") {
        solidStop();
        return;
      }
      solidSync();
      const today = localDateString(Date.now());
      if (today === seenDay) return;
      seenDay = today;
      if (currentUser) loadRealStats(currentUser);
    };
    document.addEventListener("visibilitychange", onSeenAgain);
    window.addEventListener("pageshow", onSeenAgain);
  }

  // ============================================================
  // 実績データの取得（ログイン後。user_channel_stats の累計 + user_daily_activity の今日分）
  //   ダミーの achievements・today を実データで上書きし、ホームタブを描画し直す
  // ============================================================
  async function loadRealStats(user) {
    const gen = authGen; // 失敗した時も、ログイン状態が変わっていたら画面を触らない
    statsSignedIn = true;
    renderLogKinds();
    const statusEl = document.getElementById("homeSyncStatus");
    statusEl.hidden = false;
    statusEl.classList.remove("is-error");
    statusEl.classList.add("is-loading");
    statusEl.textContent = "実績を同期中…";

    try {
      // 1 日 1 回だけ取りに行く（onceADay）。その日の 2 回目以降は端末の控えを出す
      const got = await onceADay(user, "stats", async () => {
        const today = localDateString(Date.now());
        const historyStart = localDateString(Date.now() - (HEATMAP_DAYS - 1) * 86_400_000);
        // 日別は 1 回だけ取る。今日と直近90日は、その結果から分ける（2026-10-19）
        // 共通ポイント（user_points・common_points 列）は 2026-10-06 に廃止（0042 で列を削除・0054 で表も削除）。読まない
        const [statsRes, activityRes, profileRes] = await Promise.all([
          // channels(...) は channel_id の外部キーで引く配信者名・アイコン。premium_* はチャンネルポイントの元（プレミアム中の視聴分）
          supabase.from("user_channel_stats")
            .select("channel_id, watch_ms, comment_send_count, fever_count, inferno_count, live_watch_ms, first_watch_at, points_spent, premium_watch_ms, premium_live_watch_ms, cheer_count, channels(name, avatar_url)")
            .eq("user_id", user.id),
          supabase.from("user_daily_activity")
            .select("date, watch_ms, comment_count, fever_count, inferno_count, channel_points")
            .eq("user_id", user.id).order("date", { ascending: false }).range(0, 999),
          // 自分のプロフィール（表示名・ランキング参加。設定タブに「見るだけ」で出す。変更は拡張機能から）
          supabase.from("profiles").select("display_name, ranking_opt_in, index_order").eq("user_id", user.id).maybeSingle(),
        ]);
        for (const r of [statsRes, activityRes, profileRes]) if (r.error) throw r.error;
        const activityRows = activityRes.data ?? [];
        const todayRow = activityRows.find((row) => row.date === today) ?? null;
        const historyRows = activityRows.filter((row) => row.date >= historyStart);
        return [statsRes.data ?? null, todayRow, historyRows, activityRows, profileRes.data ?? null];
      });
      if (!got) return; // 通信の間にログアウトした（画面は showLoggedOut が片付け済み）
      const { payload, at } = got;
      applyStats(payload, true);
      rerenderStats();
      loadTownData(user);
      // いつの記録かを出しておく（1 日 1 回の更新なので「反映が遅い」と思われないように）
      statusEl.hidden = false;
      statusEl.classList.remove("is-loading");
      statusEl.textContent = `${formatSnapshotTime(at)} 時点の記録です（1 日 1 回更新）`;
    } catch (err) {
      console.warn("[EmoChat] 実績データを取得できませんでした", err);
      if (gen !== authGen) return; // 通信の間にログアウト・別の人に替わった（画面はもう片付いている）
      if (showStaleStats(user, gen)) return; // 通信できない時は、最後の控えを日付つきで出す（2026-10-19）
      renderLogKinds();
      statusEl.hidden = false;
      statusEl.classList.remove("is-loading");
      statusEl.classList.add("is-error");
      // 理由も出す（素人の運営者が問い合わせを受けた時に、画面の文言だけで原因が分かるように。2026-10-14）
      const reason = [err?.code, err?.message || String(err)].filter(Boolean).join(" ");
      statusEl.textContent = `実績を取得できませんでした。（${reason}）`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry-link";
      retry.textContent = "もう一度試す";
      retry.addEventListener("click", () => { if (gen === authGen) loadRealStats(user); }); // 今もその人がログイン中の時だけ
      statusEl.append(retry);
    } finally {
      if (gen === authGen) hideLoadingScreen();
    }
  }

  // 取りに行けない時は、最後の控えを「○月○日 時点」と出して、ランキングも前回の分を試す（2026-10-19）
  function showStaleStats(user, gen) {
    const last = readStoredSnapshot(user, "stats");
    if (!last) return false;
    applyStats(last.payload, true);
    rerenderStats();
    const statusEl = document.getElementById("homeSyncStatus");
    statusEl.hidden = false;
    statusEl.classList.remove("is-loading", "is-error");
    statusEl.textContent = `${formatSnapshotDay(last.date)} 時点の記録です（通信できないため、前回の記録を表示しています）`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-link";
    retry.textContent = "もう一度試す";
    retry.addEventListener("click", () => { if (gen === authGen) loadRealStats(user); });
    statusEl.append(retry);
    loadTownData(user);
    return true;
  }

  // 取れたデータ（または EMPTY_PAYLOAD）で画面用のデータを入れ替える
  function applyStats(payload, signedIn) {
    statsSignedIn = !!signedIn;
    logDailyShown = LOG_DAILY_PAGE;
    const [statsData, todayData, historyData, activityData, profileData] = payload;

    const totals = (statsData ?? []).reduce(
      (acc, row) => ({
        watchMs: acc.watchMs + Number(row.watch_ms ?? 0),
        commentCount: acc.commentCount + Number(row.comment_send_count ?? 0),
        feverCount: acc.feverCount + Number(row.fever_count ?? 0),
      }),
      { watchMs: 0, commentCount: 0, feverCount: 0 },
    );

    // チャンネルごとの獲得ポイント（src/core/points.js の channelPointsBalance の「貯まった分」と同じ式。
    //   ライブ視聴は毎分 2pt・アーカイブ視聴は毎分 1pt。端末ごとの行をチャンネルごとに合算してから計算する）
    const byChannel = new Map();
    for (const row of statsData ?? []) {
      const cur = byChannel.get(row.channel_id) ?? { name: "", avatarUrl: "", total: 0, live: 0, watchMs: 0, liveWatchMs: 0, comments: 0, fever: 0, cheer: 0, spent: 0, first: Infinity };
      cur.spent += Number(row.points_spent ?? 0);
      cur.first = Math.min(cur.first, Date.parse(row.first_watch_at) || Infinity);
      cur.watchMs += Number(row.watch_ms ?? 0);
      cur.liveWatchMs += Number(row.live_watch_ms ?? 0);
      cur.comments += Number(row.comment_send_count ?? 0);
      cur.fever += Number(row.fever_count ?? 0);
      cur.cheer += Number(row.cheer_count ?? 0);
      cur.id = row.channel_id;
      cur.name = row.channels?.name ?? cur.name;
      cur.avatarUrl = row.channels?.avatar_url ?? cur.avatarUrl;
      cur.total += Number(row.premium_watch_ms ?? 0);
      cur.live += Number(row.premium_live_watch_ms ?? 0);
      byChannel.set(row.channel_id, cur);
    }
    DUMMY.points.common = 0; // 共通ポイントは廃止（上のコメント参照）。ダミーの値を実データで消す
    DUMMY.points.commonSpent = 0;
    DUMMY.profile.displayName = profileData?.display_name ?? "";
    DUMMY.profile.rankingOptIn = !!profileData?.ranking_opt_in;
    DUMMY.profile.indexOrder = Array.isArray(profileData?.index_order) ? profileData.index_order : [];
    DUMMY.channels = [...byChannel.values()].map((c) => {
      const liveMs = Math.max(0, Math.min(c.live, c.total));
      const points = Math.floor(liveMs / 60000) * 2 + Math.floor((c.total - liveMs) / 60000);
      return {
        id: c.id, name: c.name || "（名称不明）", avatarUrl: c.avatarUrl, points,
        watchMs: c.watchMs, liveWatchMs: c.liveWatchMs, comments: c.comments, fever: c.fever, cheer: c.cheer,
        spent: c.spent, firstWatchAt: Number.isFinite(c.first) ? c.first : 0,
      };
    });
    DUMMY.points.channels = DUMMY.channels.filter((c) => c.points > 0);

    DUMMY.activity = (activityData ?? []).map((row) => ({
      date: row.date,
      watchMs: Number(row.watch_ms ?? 0),
      commentCount: Number(row.comment_count ?? 0),
      feverCount: Number(row.fever_count ?? 0),
      infernoCount: Number(row.inferno_count ?? 0), // 爆熱（0064。拡張機能が送り始めるまでは 0）
      commonPoints: 0, // 廃止（列が無い）
      channelPoints: Number(row.channel_points ?? 0),
    }));

    DUMMY.streak = computeStreak(DUMMY.activity);
    DUMMY.achievements.totalWatchMinutes = Math.round(totals.watchMs / 60000);
    DUMMY.achievements.totalComments = totals.commentCount;
    DUMMY.achievements.hotMomentCount = totals.feverCount;
    DUMMY.today = todayData
      ? {
        watchMs: Number(todayData.watch_ms ?? 0),
        commentCount: Number(todayData.comment_count ?? 0),
        feverCount: Number(todayData.fever_count ?? 0),
      }
      : { watchMs: 0, commentCount: 0, feverCount: 0 };
    DUMMY.dailyHistory = (historyData ?? []).map((row) => ({
      date: row.date,
      watchMs: Number(row.watch_ms ?? 0),
      feverCount: Number(row.fever_count ?? 0),
    }));
  }

  // ログ・グラフは、どちらかのタブを開いている時だけ描く（2026-10-19）
  function renderLogCharts() {
    renderLog();
    renderGraph();
    renderBreakdown();
    renderViz();
    renderSolid();
    renderInsights();
    logDirty = false;
    solidSync();
  }

  function rerenderStats() {
    renderHome();
    renderSettingsProfile();
    renderLogKinds(); // タブを開いていなくても、ログアウトで前の人のログのカードが残らないようにする
    logDirty = true;
    const log = document.getElementById("view-log");
    const graph = document.getElementById("view-graph");
    if ((log && !log.hidden) || (graph && !graph.hidden)) renderLogCharts();
    else solidStop();
  }

  // ログインしていない時の画面（開いた直後・ログアウト後）。数字は全部 0・一覧は空・ランキングは案内文
  function showLoggedOut() {
    applyStats(EMPTY_PAYLOAD, false);
    rerenderStats();
    renderRanking();
    // チャンネルのページも片付ける（開いたまま別のタブでログアウトした時に、前の人の配信者名・数字が残らないように）
    document.getElementById("channelName").textContent = "";
    document.getElementById("channelSince").textContent = "";
    document.getElementById("channelStats").innerHTML = "";
    document.getElementById("indexList").replaceChildren();
    if (!document.getElementById("view-channel").hidden) activateTab("home");
    const statusEl = document.getElementById("homeSyncStatus");
    statusEl.hidden = false;
    statusEl.classList.remove("is-loading", "is-error");
    statusEl.textContent = "ログインすると、あなたの記録が見られます。";
  }

  setupAuth();
  setupGraph();
  setupViz();
  setupSolid();
  setupLogKinds();
  setupLogFolds();
  showLoggedOut();
  renderSettings();
})();

// Service Worker の登録（Android Chrome 等の「ホーム画面に追加」インストール条件を満たすため）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("[EmoChat] Service Worker の登録に失敗しました", err);
    });
  });
}
  
// ボタンを押した所から、金×オレンジの波紋を広げる（動きを減らす設定の時は CSS の発光だけ）
document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest && e.target.closest("#dashboard button");
  if (!btn || btn.disabled || btn.classList.contains("is-claimed")) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rect = btn.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "tap-ripple";
  ripple.style.left = `${e.clientX - rect.left}px`;
  ripple.style.top = `${e.clientY - rect.top}px`;
  btn.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
});
