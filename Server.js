// Server.js (complete, Render)
// このファイルは /api と /se を同時に提供する完全版です。
// public/ 配下を静的配信し、/se/*.mp3 をそのまま配信できます。

const path = require("path");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bujin.html"));
});

const rooms = new Map();
const posts = [];

function now(){ return Date.now(); }
function safeStr(v, fb=""){ return (v===null||v===undefined)?fb:String(v); }
function uid(n=8){ return crypto.randomBytes(n).toString("hex"); }

app.get("/api/health", (req,res)=>res.json({ ok:true, rooms: rooms.size, posts: posts.length }));

app.post("/api/rooms", (req,res)=>{
  const clientId = safeStr(req.body?.clientId);
  const name = safeStr(req.body?.name, "Host").slice(0, 24);
  if (!clientId) return res.status(400).json({ error:"clientId required" });

  const roomId = crypto.randomBytes(4).toString("base64url").slice(0,6).toUpperCase();
  const room = {
    roomId,
    createdAt: now(),
    hostId: clientId,
    status: "lobby",
    members: new Map(),
    voteResultText: null,
  };
  room.members.set(clientId, { clientId, name, joinedAt: now(), techniqueText:null, submittedAt:null, voteTargetId:null, votedAt:null });
  rooms.set(roomId, room);

  res.json({ roomId, hostId: room.hostId, status: room.status,
    members: Array.from(room.members.values()).map(m=>({ clientId:m.clientId, name:m.name, submitted:!!m.techniqueText, voted:!!m.voteTargetId, techniqueText: null }))
  });
});

app.post("/api/rooms/:roomId/join", (req,res)=>{
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);
  const name = safeStr(req.body?.name, "Guest").slice(0,24);
  if (!clientId) return res.status(400).json({ error:"clientId required" });

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error:"Room not found" });

  if (!room.members.has(clientId)) {
    room.members.set(clientId, { clientId, name, joinedAt: now(), techniqueText:null, submittedAt:null, voteTargetId:null, votedAt:null });
  } else {
    room.members.get(clientId).name = name;
  }

  res.json({ roomId, hostId: room.hostId, status: room.status,
    members: Array.from(room.members.values()).map(m=>({ clientId:m.clientId, name:m.name, submitted:!!m.techniqueText, voted:!!m.voteTargetId, techniqueText: null }))
  });
});

app.get("/api/rooms/:roomId", (req,res)=>{
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error:"Room not found" });

  const showTech = (room.status === "voting" || room.status === "result");
  res.json({
    roomId: room.roomId,
    hostId: room.hostId,
    status: room.status,
    voteResultText: room.voteResultText,
    members: Array.from(room.members.values()).map(m=>({
      clientId: m.clientId,
      name: m.name,
      submitted: !!m.techniqueText,
      voted: !!m.voteTargetId,
      techniqueText: showTech ? m.techniqueText : null
    }))
  });
});

app.post("/api/rooms/:roomId/start", (req,res)=>{
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error:"Room not found" });
  if (room.hostId !== clientId) return res.status(403).json({ error:"Only host can start" });

  room.status = "building";
  room.voteResultText = null;
  for (const m of room.members.values()) {
    m.techniqueText = null;
    m.submittedAt = null;
    m.voteTargetId = null;
    m.votedAt = null;
  }
  res.json({ ok:true, roomId, status: room.status });
});

app.post("/api/rooms/:roomId/technique", (req,res)=>{
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);
  const techniqueText = safeStr(req.body?.techniqueText);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error:"Room not found" });
  if (room.status !== "building") return res.status(400).json({ error:"Room is not in building phase" });

  const member = room.members.get(clientId);
  if (!member) return res.status(404).json({ error:"Member not found" });
  if (!techniqueText) return res.status(400).json({ error:"techniqueText required" });

  member.techniqueText = techniqueText.slice(0, 200);
  member.submittedAt = now();

  const allSubmitted = Array.from(room.members.values()).every(m=>!!m.techniqueText);
  if (allSubmitted) room.status = "voting";

  res.json({ ok:true, roomId, status: room.status, allSubmitted });
});

app.post("/api/rooms/:roomId/vote", (req,res)=>{
  const roomId = safeStr(req.params.roomId).toUpperCase();
  const clientId = safeStr(req.body?.clientId);
  const targetId = safeStr(req.body?.targetId);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error:"Room not found" });
  if (room.status !== "voting") return res.status(400).json({ error:"Room is not in voting phase" });

  const member = room.members.get(clientId);
  if (!member) return res.status(404).json({ error:"Member not found" });
  if (!targetId || !room.members.has(targetId)) return res.status(400).json({ error:"Invalid targetId" });

  member.voteTargetId = targetId;
  member.votedAt = now();

  const allVoted = Array.from(room.members.values()).every(m=>!!m.voteTargetId);
  if (allVoted) {
    const counts = new Map();
    for (const m of room.members.values()) {
      counts.set(m.voteTargetId, (counts.get(m.voteTargetId)||0)+1);
    }
    let winnerId=null, best=-1;
    for (const [tid,c] of counts.entries()) {
      if (c>best) { best=c; winnerId=tid; }
    }
    const winner = winnerId ? room.members.get(winnerId) : null;
    room.voteResultText = winner ? `${winner.name} の技が勝ち！（${best}票）` : "結果なし";
    room.status = "result";
  }

  res.json({ ok:true, roomId, status: room.status, allVoted, voteResultText: room.voteResultText });
});

// SNS
app.post("/api/posts", (req,res)=>{
  const clientId = safeStr(req.body?.clientId);
  const authorName = safeStr(req.body?.authorName, "名無し").slice(0,24);
  const title = safeStr(req.body?.title, "無題").slice(0,60);
  const techniqueText = safeStr(req.body?.techniqueText).slice(0,400);
  if (!clientId) return res.status(400).json({ error:"clientId required" });
  if (!techniqueText) return res.status(400).json({ error:"techniqueText required" });

  const post = { id: uid(8), createdAt: now(), title, techniqueText, authorName, clientId, likes:0, likedBy: new Set() };
  posts.unshift(post);
  res.json({ ok:true, post: { id: post.id, createdAt: post.createdAt, title: post.title, techniqueText: post.techniqueText, authorName: post.authorName, likes: post.likes, liked:false } });
});

app.get("/api/posts", (req,res)=>{
  const clientId = safeStr(req.query?.clientId);
  const limit = Math.min(parseInt(req.query.limit || "20",10), 100);
  const sliced = posts.slice(0, limit).map(p=>({
    id: p.id,
    createdAt: p.createdAt,
    title: p.title,
    techniqueText: p.techniqueText,
    authorName: p.authorName,
    likes: p.likes || 0,
    liked: clientId ? p.likedBy.has(clientId) : false,
  }));
  res.json({ ok:true, posts: sliced });
});

app.post("/api/posts/:postId/like", (req,res)=>{
  const postId = safeStr(req.params.postId);
  const clientId = safeStr(req.body?.clientId);
  if (!clientId) return res.status(400).json({ error:"clientId required" });
  const post = posts.find(p=>p.id===postId);
  if (!post) return res.status(404).json({ error:"Post not found" });

  let liked;
  if (post.likedBy.has(clientId)) { post.likedBy.delete(clientId); post.likes = Math.max(0,(post.likes||0)-1); liked=false; }
  else { post.likedBy.add(clientId); post.likes = (post.likes||0)+1; liked=true; }
  res.json({ ok:true, postId, likes: post.likes, liked });
});

app.listen(PORT, ()=>console.log("Bushin server listening on port", PORT));
