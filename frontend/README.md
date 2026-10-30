# Frontend — YouTube Party

React 19 + TypeScript + Vite client. See the [root README](../README.md) for setup.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build
npm run lint     # oxlint
```

## Folders

| Folder | Purpose |
| --- | --- |
| `src/pages` | Route components (`/`, `/room/:roomCode`, 404) |
| `src/components` | Reusable UI |
| `src/hooks` | Custom React hooks |
| `src/services` | HTTP API calls |
| `src/socket` | Socket.IO client (Phase 2) |
| `src/utils` | Pure helpers |

Dev requests to `/api` are proxied to `http://localhost:5000` (see `vite.config.ts`).
