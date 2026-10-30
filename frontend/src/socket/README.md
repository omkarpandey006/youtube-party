# Socket.IO client

`socket.ts` creates a typed Socket.IO client for the presence layer.

- `createWatchPartySocket()` → `autoConnect: false`, so the caller decides when to connect.
- Reconnection is enabled (infinite attempts, 500 ms → 5 s backoff).
- On every `connect` (including reconnects) the caller must emit `join_room`
  with the stored participant token, because the server keeps no per-socket state.
- Default URL is the page origin; Vite proxies `/socket.io` to `http://localhost:5000`.
  Set `VITE_SOCKET_URL` only when the API is on another origin.

The `useRoom()` hook in `src/hooks/useRoom.ts` wires this together with REST
identity tokens. Event reference: [`docs/SOCKET_EVENTS.md`](../../../docs/SOCKET_EVENTS.md).
