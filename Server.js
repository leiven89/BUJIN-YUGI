// server.js
const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// メモリ上に全部保持（PCを再起動すると消える簡易版）
const rooms = {}; // roomId -> { roomId, players: [{id,name,techName}] }
const posts = []; // 技SNS用

// ランダム4桁ルームID生成
function generateRoomId() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ---------- ルーム系 API ----------

// ルーム作成
app.post("/api/rooms", (req, res) => {
  const playerName = req.body.playerName || "プレイヤー";
  const roomId = generateRoomId();
  const playerId = randomUUID();

  rooms[roomId] = {
    roomId,
    players: [
      { id: playerId, name: playerName, techName: "" }
    ]
  };

  res.json({ roomId, playerId });
});

// ルーム参加
app.post("/api/rooms/:roomId/join", (req, res) => {
  const roomId = req.params.roomId;
  const playerName = req.body.playerName || "プレイヤー";

  if (!rooms[roomId]) {
    rooms[roomId] = { roomId, players: [] };
  }

  const playerId = randomUUID();
  rooms[roomId].players.push({
    id: playerId,
    name: playerName,
    techName: ""
  });

  res.json({ roomId, playerId });
});

// ルーム状態取得
app.get("/api/rooms/:roomId", (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  res.json({
    roomId: room.roomId,
    players: room.players
  });
});

// 技をルームに投稿
app.post("/api/rooms/:roomId/technique", (req, res) => {
  const roomId = req.params.roomId;
  const { playerId, techName } = req.body;

  const room = rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return res.status(404).json({ error: "Player not in this room" });
  }

  player.techName = techName;
  res.json({ ok: true });
});

// ---------- 技SNS系 API ----------

// 技投稿
app.post("/api/posts", (req, res) => {
  const { author, title, technique, body } = req.body;
  const post = {
    id: randomUUID(),
    author: author || "名無し",
    title: title || technique || "無題の技",
    technique: technique || "",
    body: body || "",
    createdAt: Date.now()
  };
  posts.unshift(post);       // 新しい順
  if (posts.length > 100) {  // 最大100件
    posts.length = 100;
  }
  res.json(post);
});

// 最新の投稿一覧
app.get("/api/posts", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
  res.json(posts.slice(0, limit));
});

// ---------- サーバー起動 ----------
app.listen(PORT, () => {
  console.log(`武神遊戯サーバー起動中: http://localhost:${PORT}`);
});
