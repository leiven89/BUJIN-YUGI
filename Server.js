// server.js
// 武神遊戯 オンライン対戦サーバー（Render向け）
// - ルーム作成/参加
// - ホスト開始
// - 技提出（全員提出で投票へ）
// - 投票（全員投票で結果へ）
// - 技SNS（投稿/一覧）
// - いいね（トグル、clientIdで重複防止）

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -----------------------------
// In-memory storage
// -----------------------------
/**
 * rooms: Map<string, Room>
 * Room = {
 *   roomId: string,
 *   createdAt: number,
 *   phase: "lobby" | "building" | "voting" | "result",
 *   hostId: string,
 *   players: Array<{ id, name, techName, ready, voteFor }>,
 *   votes: Record<string, number>,
 *   winnerIds: string[],
 *   lastResultText: string | null
 * }
 */
const rooms = new Map();

/**
 * posts: Array<Post>
 * Post = {
 *   id: string,
 *   author: string,
 *   title: string,
 *   technique: string,
 *   body: string,
 *   createdAt: number,
 *   likes: number,
 *   likedBy: Set<string> // clientId
 * }
 */
const posts = [];

// -----------------------------
// Helpers
// -----------------------------
function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

function generateRoomId() {
  // 4桁数字（衝突したら作り直し）
  return String(Math.floor(1000 + Math.random() * 9000));
}

function getRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    const err = new Error("Room not found");
    err.status = 404;
    throw err;
  }
  return room;
}

function getPlayer(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) {
    const err = new Error("Player not found in room");
    err.status = 404;
    throw err;
  }
  return p;
}

function toPublicRoom(room) {
  return {
    roomId: room.roomId,
    createdAt: room.createdAt,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      techName: p.techName,
      ready: p.ready,
      voteFor: p.voteFor || null,
    })),
    votes: room.votes,
    winnerIds: room.winnerIds,
    lastResultText: room.lastResultText,
  };
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

// Create room
app.post("/api/rooms", (req, res, next) => {
  try {
    const playerName = safeStr(req.body?.playerName, "プレイヤー").slice(0, 20);

    let roomId = generateRoomId();
    while (rooms.has(roomId)) roomId = generateRoomId();

    const hostId = generateId();

    const room = {
      roomId,
      createdAt: Date.now(),
      phase: "lobby",
      hostId,
      players: [
        {
          id: hostId,
          name: playerName,
          techName: "",
          ready: false,
          voteFor: null,
        },
      ],
      votes: {},
      winnerIds: [],
      lastResultText: null,
    };

    rooms.set(roomId, room);

    res.json({ roomId, playerId: hostId, isHost: true });
  } catch (e) {
    next(e);
  }
});

// Join room
app.post("/api/rooms/:roomId/join", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const room = getRoom(roomId);

    const playerName = safeStr(req.body?.playerName, "プレイヤー").slice(0, 20);
    const playerId = generateId();

    room.players.push({
      id: playerId,
      name: playerName,
      techName: "",
      ready: false,
      voteFor: null,
    });

    res.json({ roomId, playerId, isHost: false });
  } catch (e) {
    next(e);
  }
});

// Get room state
app.get("/api/rooms/:roomId", (req, res, next) => {
  try {
    const room = getRoom(req.params.roomId);
    res.json(toPublicRoom(room));
  } catch (e) {
    next(e);
  }
});

// Host starts battle (reset states)
app.post("/api/rooms/:roomId/start", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const playerId = safeStr(req.body?.playerId, "");

    const room = getRoom(roomId);
    if (!playerId || room.hostId !== playerId) {
      const err = new Error("Only host can start battle");
      err.status = 403;
      throw err;
    }

    room.phase = "building";
    room.players.forEach((p) => {
      p.techName = "";
      p.ready = false;
      p.voteFor = null;
    });
    room.votes = {};
    room.winnerIds = [];
    room.lastResultText = null;

    res.json(toPublicRoom(room));
  } catch (e) {
    next(e);
  }
});

// Submit technique (ready)
app.post("/api/rooms/:roomId/technique", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const playerId = safeStr(req.body?.playerId, "");
    const techName = safeStr(req.body?.techName, "").slice(0, 40);

    if (!playerId || !techName) {
      const err = new Error("playerId and techName required");
      err.status = 400;
      throw err;
    }

    const room = getRoom(roomId);

    if (room.phase !== "building") {
      const err = new Error("Not in building phase");
      err.status = 400;
      throw err;
    }

    const player = getPlayer(room, playerId);
    player.techName = techName;
    player.ready = true;

    const allReady =
      room.players.length > 0 && room.players.every((p) => p.ready);

    if (allReady) {
      room.phase = "voting";
      // 念のため投票状態はクリア
      room.players.forEach((p) => (p.voteFor = null));
    }

    res.json(toPublicRoom(room));
  } catch (e) {
    next(e);
  }
});

// Vote
app.post("/api/rooms/:roomId/vote", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const playerId = safeStr(req.body?.playerId, "");
    const targetPlayerId = safeStr(req.body?.targetPlayerId, "");

    if (!playerId || !targetPlayerId) {
      const err = new Error("playerId and targetPlayerId required");
      err.status = 400;
      throw err;
    }

    const room = getRoom(roomId);
    if (room.phase !== "voting") {
      const err = new Error("Voting is not active");
      err.status = 400;
      throw err;
    }

    const voter = getPlayer(room, playerId);
    const target = getPlayer(room, targetPlayerId);

    if (voter.id === target.id) {
      const err = new Error("You cannot vote for yourself");
      err.status = 400;
      throw err;
    }

    voter.voteFor = target.id;

    const allVoted =
      room.players.length > 0 && room.players.every((p) => !!p.voteFor);

    if (allVoted) {
      // tally
      room.votes = {};
      room.players.forEach((p) => {
        room.votes[p.id] = 0;
      });
      room.players.forEach((p) => {
        if (p.voteFor) room.votes[p.voteFor] = (room.votes[p.voteFor] || 0) + 1;
      });

      let maxVotes = 0;
      Object.values(room.votes).forEach((v) => {
        if (v > maxVotes) maxVotes = v;
      });

      room.winnerIds = Object.entries(room.votes)
        .filter(([_, v]) => v === maxVotes)
        .map(([id]) => id);

      // result text
      const lines = [];
      lines.push("投票結果");
      room.players.forEach((p) => {
        const v = room.votes[p.id] || 0;
        lines.push(`・${p.name}「${p.techName || "（未投稿）"}」…… ${v}票`);
      });

      if (room.winnerIds.length === 0) {
        lines.push("\n勝者なし");
      } else {
        const winners = room.players.filter((p) => room.winnerIds.includes(p.id));
        lines.push(
          "\n🏆 勝者：" + winners.map((w) => `${w.name}「${w.techName}」`).join(" ／ ")
        );
      }

      room.lastResultText = lines.join("\n");
      room.phase = "result";
    }

    res.json(toPublicRoom(room));
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// Posts (Technique SNS)
// -----------------------------

// Create post
app.post("/api/posts", (req, res, next) => {
  try {
    const author = safeStr(req.body?.author, "名無し").slice(0, 20);
    const title = safeStr(req.body?.title, "").slice(0, 60);
    const technique = safeStr(req.body?.technique, "").slice(0, 60);
    const body = safeStr(req.body?.body, "").slice(0, 300);

    if (!technique) {
      const err = new Error("technique is required");
      err.status = 400;
      throw err;
    }

    const post = {
      id: generateId(),
      author,
      title: title || technique,
      technique,
      body,
      createdAt: Date.now(),
      likes: 0,
      likedBy: new Set(),
    };

    posts.unshift(post);
    if (posts.length > 300) posts.length = 300;

    // SetはJSONにできないので「返す用」は整形
    res.json({
      id: post.id,
      author: post.author,
      title: post.title,
      technique: post.technique,
      body: post.body,
      createdAt: post.createdAt,
      likes: post.likes,
    });
  } catch (e) {
    next(e);
  }
});

// List posts
app.get("/api/posts", (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const sliced = posts.slice(0, limit).map((p) => ({
      id: p.id,
      author: p.author,
      title: p.title,
      technique: p.technique,
      body: p.body,
      createdAt: p.createdAt,
      likes: p.likes || 0,
    }));
    res.json(sliced);
  } catch (e) {
    next(e);
  }
});

// Like toggle
app.post("/api/posts/:postId/like", (req, res, next) => {
  try {
    const postId = req.params.postId;
    const clientId = safeStr(req.body?.clientId, "").slice(0, 80);

    if (!clientId) {
      const err = new Error("clientId required");
      err.status = 400;
      throw err;
    }

    const post = posts.find((p) => p.id === postId);
    if (!post) {
      const err = new Error("Post not found");
      err.status = 404;
      throw err;
    }

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

    res.json({ postId: post.id, likes: post.likes, liked });
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// Error handler
// -----------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ error: err.message || "Internal Server Error" });
});

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => {
  console.log(`Bushin server listening on port ${PORT}`);
});
