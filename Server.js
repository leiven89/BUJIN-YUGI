// Server.js
// 武神遊戯 オンライン対戦サーバー（Render向け）
// - ルーム作成/参加
// - ホスト開始
// - 技提出（全員提出で投票へ）
// - 投票（全員投票で結果へ）
// - 技SNS（投稿/一覧）
// - いいね（トグル、clientIdで重複防止）
//
// 静的配信:
//   public/ 配下を配信します（/bujin.html, /se/*.mp3 など）

const path = require("path");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// --- middleware ---
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// 静的ファイル（HTML/SEなど）配信
app.use(express.static(path.join(__dirname, "public")));

// トップをbujin.htmlに（任意だけど便利）
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bujin.html"));
});

// -----------------------------
// In-memory storage（無料プラン想定：永続化なし）
// -----------------------------
/**
 * Room = {
 *   roomId: string,
 *   createdAt: number,
 *   hostId: string,
 *   status: "lobby" | "building" | "voting" | "result",
 *   members: Map<string, {
 *     clientId: string,
 *     name: string,
 *     joinedAt: number,
 *     techniqueText: string | null,
 *     submittedAt: number | null,
 *     voteTargetId: string | null,
 *     votedAt: number | null
 *   }>,
 *   voteResultText: string | null
 * }
 */
const rooms = new Map(); // roomId -> Room

/**
 * Post = {
 *   id: string,
 *   createdAt: number,
 *   title: string,
 *   techniqueText: string,
 *   authorName: string,
 *   clientId: string,
 *   likes: number,
 *   likedBy: Set<string>
 * }
 */
const posts = []; // 最新が先頭に来るようにunshift

function uid(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}

function now() {
  return Date.now();
}

function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

// -----------------------------
// Health
// -----------------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.size, posts: posts.length });
});

// -----------------------------
// Rooms
// -----------------------------

// ルーム作成
app.post("/api/rooms", (req, res) => {
  const hostId = safeStr(req.body?.clientId);
  const hostName = safeStr(req.body?.name, "Host");

  if (!hostId) return res.status(400).json({ error: "clientId required" });

  // 6桁のルームコード（英数字）
  const roomId = crypto.randomBytes(4).toString("base64url").slice(0, 6).toUpperCase();

  const room = {
    roomId,
    createdAt: now(),
    hostId,
    status: "lobby",
    members: new Map(),
    voteResultText: null,
  };

  room.members.set(hostId, {
    clientId: hostId,
    name: hostName,
    joinedAt: now(),
    techniqueText: null,
    submittedAt: null,
    voteTargetId: null,
    votedAt: null,
  });

  rooms.set(roomId, room);

  res.json({
    roomId,
    hostId,
    status: room.status,
    members: Array.from(room.members.values()).map((m) => ({
      clientId: m.clientId,
      name: m.name,
      submitted: !!m.techniqueText,
      voted: !!m.voteTargetId,
    })),
  });
});

// ルーム参加
app.post("/api/rooms/:roomId/join", (req, res) => {
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);
  const name = safeStr(req.body?.name, "Guest");

  if (!clientId) return res.status(400).json({ error: "clientId required" });

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (!room.members.has(clientId)) {
    room.members.set(clientId, {
      clientId,
      name,
      joinedAt: now(),
      techniqueText: null,
      submittedAt: null,
      voteTargetId: null,
      votedAt: null,
    });
  } else {
    // 名前更新だけ反映
    room.members.get(clientId).name = name;
  }

  res.json({
    roomId,
    hostId: room.hostId,
    status: room.status,
    members: Array.from(room.members.values()).map((m) => ({
      clientId: m.clientId,
      name: m.name,
      submitted: !!m.techniqueText,
      voted: !!m.voteTargetId,
    })),
  });
});

// ルーム状態取得（ポーリング用）
app.get("/api/rooms/:roomId", (req, res) => {
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const members = Array.from(room.members.values()).map((m) => ({
    clientId: m.clientId,
    name: m.name,
    submitted: !!m.techniqueText,
    voted: !!m.voteTargetId,
    techniqueText: room.status === "result" ? m.techniqueText : null,
  }));

  res.json({
    roomId,
    hostId: room.hostId,
    status: room.status,
    members,
    voteResultText: room.voteResultText,
  });
});

// ホストが開始（ビルドフェーズへ）
app.post("/api/rooms/:roomId/start", (req, res) => {
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.hostId !== clientId) return res.status(403).json({ error: "Only host can start" });

  room.status = "building";
  room.voteResultText = null;

  // 提出/投票リセット
  for (const m of room.members.values()) {
    m.techniqueText = null;
    m.submittedAt = null;
    m.voteTargetId = null;
    m.votedAt = null;
  }

  res.json({ ok: true, roomId, status: room.status });
});

// 技提出
app.post("/api/rooms/:roomId/technique", (req, res) => {
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);
  const techniqueText = safeStr(req.body?.techniqueText);

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.status !== "building") return res.status(400).json({ error: "Room is not in building phase" });

  const member = room.members.get(clientId);
  if (!member) return res.status(404).json({ error: "Member not found" });

  if (!techniqueText) return res.status(400).json({ error: "techniqueText required" });

  member.techniqueText = techniqueText;
  member.submittedAt = now();

  // 全員提出したら投票へ
  const allSubmitted = Array.from(room.members.values()).every((m) => !!m.techniqueText);
  if (allSubmitted) {
    room.status = "voting";
  }

  res.json({
    ok: true,
    roomId,
    status: room.status,
    allSubmitted,
  });
});

// 投票（誰の技が良いか）
app.post("/api/rooms/:roomId/vote", (req, res) => {
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);
  const targetId = safeStr(req.body?.targetId);

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.status !== "voting") return res.status(400).json({ error: "Room is not in voting phase" });

  const member = room.members.get(clientId);
  if (!member) return res.status(404).json({ error: "Member not found" });

  if (!targetId || !room.members.has(targetId)) return res.status(400).json({ error: "Invalid targetId" });

  member.voteTargetId = targetId;
  member.votedAt = now();

  // 全員投票したら結果へ
  const allVoted = Array.from(room.members.values()).every((m) => !!m.voteTargetId);
  if (allVoted) {
    // 集計
    const counts = new Map(); // targetId -> count
    for (const m of room.members.values()) {
      counts.set(m.voteTargetId, (counts.get(m.voteTargetId) || 0) + 1);
    }
    // 勝者（同票なら先に入った方）
    let winnerId = null;
    let best = -1;
    for (const [tid, c] of counts.entries()) {
      if (c > best) {
        best = c;
        winnerId = tid;
      }
    }
    const winner = winnerId ? room.members.get(winnerId) : null;
    room.voteResultText = winner ? `${winner.name} の技が勝ち！（${best}票）` : "結果なし";
    room.status = "result";
  }

  res.json({ ok: true, roomId, status: room.status, allVoted, voteResultText: room.voteResultText });
});

// -----------------------------
// SNS Posts
// -----------------------------

// 投稿
app.post("/api/posts", (req, res) => {
  const clientId = safeStr(req.body?.clientId);
  const authorName = safeStr(req.body?.authorName, "名無し");
  const title = safeStr(req.body?.title, "無題");
  const techniqueText = safeStr(req.body?.techniqueText);

  if (!clientId) return res.status(400).json({ error: "clientId required" });
  if (!techniqueText) return res.status(400).json({ error: "techniqueText required" });

  const post = {
    id: uid(8),
    createdAt: now(),
    title: title.slice(0, 60),
    techniqueText: techniqueText.slice(0, 400),
    authorName: authorName.slice(0, 24),
    clientId,
    likes: 0,
    likedBy: new Set(),
  };

  posts.unshift(post);

  res.json({
    ok: true,
    post: {
      id: post.id,
      createdAt: post.createdAt,
      title: post.title,
      techniqueText: post.techniqueText,
      authorName: post.authorName,
      likes: post.likes,
      liked: false,
    },
  });
});

// 一覧
app.get("/api/posts", (req, res) => {
  const clientId = safeStr(req.query?.clientId);

  res.json({
    ok: true,
    posts: posts.map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      title: p.title,
      techniqueText: p.techniqueText,
      authorName: p.authorName,
      likes: p.likes || 0,
      liked: clientId ? p.likedBy?.has(clientId) : false,
    })),
  });
});

// いいね（トグル）
app.post("/api/posts/:postId/like", (req, res) => {
  const postId = safeStr(req.params.postId);
  const clientId = safeStr(req.body?.clientId);

  if (!clientId) return res.status(400).json({ error: "clientId required" });

  const post = posts.find((p) => p.id === postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  if (!post.likedBy) post.likedBy = new Set();
  if (typeof post.likes !== "number") post.likes = 0;

  let liked;
  if (post.likedBy.has(clientId)) {
    post.likedBy.delete(clientId);
    post.likes = Math.max(0, post.likes - 1);
    liked = false;
  } else {
    post.likedBy.add(clientId);
    post.likes += 1;
    liked = true;
  }

  res.json({ ok: true, postId, likes: post.likes, liked });
});

// -----------------------------
// Error handler
// -----------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log("Bushin server listening on port", PORT);
});
