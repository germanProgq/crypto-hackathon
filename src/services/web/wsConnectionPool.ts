// WebSocket connection pool with room fanout and minimal payload reuse.
type SocketLike = {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
  binaryType?: string;
};

type PoolStats = {
  connections: number;
  rooms: number;
  avgRoomSize: number;
};

const openState = 1;

export class ConnectionPool {
  private connections = new Map<string, SocketLike>();
  private roomSubscriptions = new Map<string, Set<string>>();
  private connectionRooms = new Map<string, Set<string>>();
  private pongPayload = Buffer.from(JSON.stringify({ type: "pong" }));

  add(id: string, socket: SocketLike): void {
    const existing = this.connections.get(id);
    if (existing && existing !== socket) {
      try {
        existing.close(1000, "replaced");
      } catch {}
    }
    this.connections.set(id, socket);
    this.connectionRooms.set(id, new Set());
    if ("binaryType" in socket) {
      socket.binaryType = "nodebuffer";
    }
  }

  remove(id: string): void {
    const rooms = this.connectionRooms.get(id);
    if (rooms) {
      for (const room of rooms) {
        const members = this.roomSubscriptions.get(room);
        if (members) {
          members.delete(id);
          if (members.size === 0) {
            this.roomSubscriptions.delete(room);
          }
        }
      }
    }
    this.connectionRooms.delete(id);
    this.connections.delete(id);
  }

  close(id: string, code?: number, reason?: string): void {
    const socket = this.connections.get(id);
    if (socket) {
      try {
        socket.close(code, reason);
      } catch {}
    }
    this.remove(id);
  }

  closeAll(code?: number, reason?: string): void {
    for (const id of this.connections.keys()) {
      this.close(id, code, reason);
    }
  }

  joinRoom(id: string, room: string): void {
    const rooms = this.connectionRooms.get(id);
    if (!rooms || rooms.has(room)) {
      return;
    }
    rooms.add(room);
    let members = this.roomSubscriptions.get(room);
    if (!members) {
      members = new Set();
      this.roomSubscriptions.set(room, members);
    }
    members.add(id);
  }

  leaveRoom(id: string, room: string): void {
    const rooms = this.connectionRooms.get(id);
    if (rooms && rooms.has(room)) {
      rooms.delete(room);
    }
    const members = this.roomSubscriptions.get(room);
    if (!members) {
      return;
    }
    members.delete(id);
    if (members.size === 0) {
      this.roomSubscriptions.delete(room);
    }
  }

  isInRoom(id: string, room: string): boolean {
    return this.connectionRooms.get(id)?.has(room) ?? false;
  }

  hasRoom(room: string): boolean {
    return (this.roomSubscriptions.get(room)?.size ?? 0) > 0;
  }

  getRoomMembers(room: string): Set<string> | null {
    return this.roomSubscriptions.get(room) ?? null;
  }

  getRoomsByPrefix(prefix: string): string[] {
    const rooms: string[] = [];
    for (const room of this.roomSubscriptions.keys()) {
      if (room.startsWith(prefix)) {
        rooms.push(room);
      }
    }
    return rooms;
  }

  send(id: string, payload: string | Buffer): boolean {
    const socket = this.connections.get(id);
    if (!socket) {
      return false;
    }
    if (typeof socket.readyState === "number" && socket.readyState !== openState) {
      return false;
    }
    try {
      socket.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  sendPong(id: string): boolean {
    return this.send(id, this.pongPayload);
  }

  get stats(): PoolStats {
    const rooms = this.roomSubscriptions.size;
    let roomSizeTotal = 0;
    if (rooms > 0) {
      for (const members of this.roomSubscriptions.values()) {
        roomSizeTotal += members.size;
      }
    }
    return {
      connections: this.connections.size,
      rooms,
      avgRoomSize: rooms > 0 ? roomSizeTotal / rooms : 0
    };
  }
}
