// server.js (Node 22+, ESM)
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { uniqueNamesGenerator, adjectives, colors, animals } from "unique-names-generator";
import dotenv from "dotenv";
import os from "os";

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const interfaceName in interfaces) {
    const addresses = interfaces[interfaceName];
    for (const addressInfo of addresses) {
      // Filter for IPv4 addresses that are not internal (loopback)
      if (addressInfo.family === 'IPv4' && !addressInfo.internal) {
        return addressInfo.address;
      }
    }
  }
  return null; // No suitable IP address found
}

const localIp = getLocalIpAddress();
if (localIp) {
  console.log(`Local IP Address: ${localIp}`);
} else {
  console.log('Could not determine local IP address.');
}

dotenv.config();

const PORT = process.env.PORT || 8000;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.get("/", (_req, res) => res.send("OK"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['https://your-gh-pages-domain'], credentials: false },
});

const rooms = new Map(); // slug -> { hostId: string, players: Set<string> }

function makeRoomSlug() {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    separator: "-",
    length: 3,
    style: "lowerCase",
  });
}

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on("handshake", (payload = {}, ack) => {
    const { role, room } = payload;

    if (role === "host") {
      let slug = makeRoomSlug();
      while (rooms.has(slug)) slug = makeRoomSlug();

      rooms.set(slug, { hostId: socket.id, players: new Set() });
      socket.data.role = "host";
      socket.data.room = slug;
      socket.join(slug);

      ack?.({ ok: true, room: slug });
      io.to(slug).emit("system:host-joined", { room: slug, localIp });
      console.log(`[host] ${socket.id} created room ${slug}`);
      return;
    }

    if (role === "player") {
      if (!room || !rooms.has(room)) {
        ack?.({ ok: false, error: "ROOM_NOT_FOUND" });
        return;
      }
      const info = rooms.get(room);
      socket.data.role = "player";
      socket.data.room = room;
      info.players.add(socket.id);
      socket.join(room);

      ack?.({ ok: true, room });
      io.to(info.hostId).emit("player:joined", { playerId: socket.id });
      console.log(`[player] ${socket.id} joined room ${room}`);
      return;
    }

    ack?.({ ok: false, error: "ROLE_REQUIRED" });
  });

  socket.on("player:connected", (data) =>
    forwardToHost(socket, "player:connected", data)
  );
  socket.on("player:allowed", (data) =>
    forwardToHost(socket, "player:allowed", data)
  );
  socket.on("player:button", (data) =>
    forwardToHost(socket, "player:button", data)
  );
  socket.on("player:accel", (data) =>
    forwardToHost(socket, "player:accel", data, { volatile: true })
  );

  socket.on("disconnect", (reason) => {
    const role = socket.data?.role;
    const room = socket.data?.room;

    if (room && rooms.has(room)) {
      const info = rooms.get(room);

      if (role === "host" && info.hostId === socket.id) {
        io.to(room).emit("system:host-left");
        io.in(room).socketsLeave(room);
        rooms.delete(room);
        console.log(`[host] ${socket.id} left; room ${room} deleted`);
      } else if (role === "player") {
        info.players.delete(socket.id);
        io.to(info.hostId).emit("player:left", { playerId: socket.id });
        console.log(`[player] ${socket.id} left room ${room}`);
      }
    }

    console.log(`[disconnect] ${socket.id} (${reason})`);
  });
});

function forwardToHost(socket, eventName, payload, { volatile = false } = {}) {
  const room = socket.data?.room;
  if (!room || !rooms.has(room)) return;
  const hostId = rooms.get(room).hostId;

  const op = io.to(hostId);
  const emitter = volatile ? op.volatile : op;

  emitter.emit(eventName, {
    playerId: socket.id,
    data: payload,
    ts: Date.now(),
  });
}

server.listen(PORT, () => {
  console.log(`🖥️  Listening on http://localhost:${PORT}`);
});
