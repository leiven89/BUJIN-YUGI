// server.js
// 武神遊戯 オンライン対戦サーバー
// - ルーム作成 / 参加
// - バトル開始（ホスト）
// - 技投稿 → 準備完了
// - 全員準備完了で「投票フェーズ」
// - 投票完了で「結果フェーズ」
// - 技SNS（/posts）

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========== データ構造 ==========

/**
 * rooms: Map<roomId, Room>
 * Room = {
 *   roomId,
 *   createdAt,
 *   phase: "lobby" | "building" | "voting" | "result",
 *   hostId,
 *   players: [
 *     { id, name, techName, ready, voteFor }
 *   ],
 *   votes: { [targetId]: number },
 *   winnerIds: string[],
 *   lastResultText: string | null
 * }
 */
const rooms = new Map();

/**
 * posts: 技SNS用
 * { id, author, title, technique, body, createdAt }
 */
const posts = [];

// ========== ヘルパー関数 ==========

function generateRoomId() {
  // 4桁の数字
  return String(Math.floor(1000 + Math.random() * 9000));
}

function generateId() {
  return crypto.randomBytes(8).toString("hex");
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
  const p = room.players.find(pl => pl.id === playerId);
  if (!p) {
    const err = new Error("Player not found in room");
    err.status = 404;
    throw err;
  }
  return p;
}

function toPublicRoom(room) {
  // プレイヤー側に返してOKな情報だけ返す
  return {
    roomId: room.roomId,
    createdAt: room.createdAt,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      techName: p.techName,
      ready: p.ready,
      voteFor: p.voteFor || null
    })),
    votes: room.votes,
    winnerIds: room.winnerIds,
    lastResultText: room.lastResultText
  };
}

// ========== ルームAPI ==========

// ルーム作成
app.post("/api/rooms", (req, res, next) => {
  try {
    const { playerName } = req.body || {};
    const name = playerName || "プレイヤー";

    let roomId = generateRoomId();
    while (rooms.has(roomId)) {
      roomId = generateRoomId();
    }

    const playerId = generateId();

    const room = {
      roomId,
      createdAt: Date.now(),
      phase: "lobby",
      hostId: playerId,
      players: [
        { id: playerId, name, techName: "", ready: false, voteFor: null }
      ],
      votes: {},
      winnerIds: [],
      lastResultText: null
    };

    rooms.set(roomId, room);

    res.json({
      roomId,
      playerId,
      isHost: true
    });
  } catch (e) {
    next(e);
  }
});

// ルーム参加
app.post("/api/rooms/:roomId/join", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const { playerName } = req.body || {};
    const name = playerName || "プレイヤー";

    const room = getRoom(roomId);

    const playerId = generateId();
    room.players.push({
      id: playerId,
      name,
      techName: "",
      ready: false,
      voteFor: null
    });

    res.json({
      roomId,
      playerId,
      isHost: room.hostId === playerId
    });
  } catch (e) {
    next(e);
  }
});

// ルーム状態取得
app.get("/api/rooms/:roomId", (req, res, next) => {
  try {
    const room = getRoom(req.params.roomId);
    res.json(toPublicRoom(room));
  } catch (e) {
    next(e);
  }
});

// ホストがバトル開始
app.post("/api/rooms/:roomId/start", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const { playerId } = req.body || {};
    const room = getRoom(roomId);

    if (!playerId || room.hostId !== playerId) {
      const err = new Error("Only host can start battle");
      err.status = 403;
      throw err;
    }

    // 戦闘開始：全員の技と投票状態をリセット
    room.phase = "building";
    room.players.forEach(p => {
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

// 技を送信（＝準備完了）
app.post("/api/rooms/:roomId/technique", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const { playerId, techName } = req.body || {};
    if (!playerId || !techName) {
      const err = new Error("playerId and techName required");
      err.status = 400;
      throw err;
    }

    const room = getRoom(roomId);
    const player = getPlayer(room, playerId);

    player.techName = String(techName);
    player.ready = true;

    // buildingフェーズ中で、全員readyなら投票フェーズへ
    if (room.phase === "building") {
      const allReady =
        room.players.length > 0 && room.players.every(p => p.ready);
      if (allReady) {
        room.phase = "voting";
      }
    }

    res.json(toPublicRoom(room));
  } catch (e) {
    next(e);
  }
});

// 投票
app.post("/api/rooms/:roomId/vote", (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const { playerId, targetPlayerId } = req.body || {};

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

    // 全員が投票済みかチェック
    const allVoted =
      room.players.length > 0 && room.players.every(p => !!p.voteFor);
    if (allVoted) {
      // 集計
      room.votes = {};
      room.players.forEach(p => {
        if (p.voteFor) {
          room.votes[p.voteFor] = (room.votes[p.voteFor] || 0) + 1;
        }
      });

      // 最大票数
      let maxVotes = 0;
      Object.values(room.votes).forEach(v => {
        if (v > maxVotes) maxVotes = v;
      });

      // 勝者（同票なら複数）
      room.winnerIds = Object.entries(room.votes)
        .filter(([_, v]) => v === maxVotes)
        .map(([id]) => id);

      // 結果テキスト
      const lines = [];
      lines.push("投票結果");
      room.players.forEach(p => {
        const v = room.votes[p.id] || 0;
        lines.push(`・${p.name}「${p.techName || "（未投稿）"}」…… ${v}票`);
      });

      if (room.winnerIds.length === 0) {
        lines.push("\n勝者なし（投票がありませんでした）");
      } else {
        const winners = room.players.filter(p =>
          room.winnerIds.includes(p.id)
        );
        lines.push(
          "\n🏆 勝者：" +
            winners.map(w => `${w.name}「${w.techName}」`).join(" ／ ")
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

// ========== 技SNS ==========

app.post("/api/posts", (req, res, next) => {
  try {
    const { author, title, technique, body } = req.body || {};
    if (!technique) {
      const err = new Error("technique is required");
      err.status = 400;
      throw err;
    }
    const post = {
      id: generateId(),
      author: author || "名無し",
      title: title || technique,
      technique,
      body: body || "",
      createdAt: Date.now()
    };
    posts.unshift(post);
    if (posts.length > 200) posts.length = 200;
    res.json(post);
  } catch (e) {
    next(e);
  }
});

app.get("/api/posts", (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    res.json(posts.slice(0, limit));
  } catch (e) {
    next(e);
  }
});

// ========== ヘルスチェック ==========

app.get("/api/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.size, posts: posts.length });
});

// ========== エラーハンドラ ==========

app.use((err, req, res, next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ error: err.message || "Internal Server Error" });
});

// ========== サーバー起動 ==========

app.listen(PORT, () => {
  console.log(`Bushin server listening on port ${PORT}`);
});
