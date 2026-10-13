/** Backend areas the differential runner does not compare, with the reason. */
export const UNSUPPORTED: { area: string; reason: string }[] = [
  {
    area: 'HTTP transport, express middleware, rate limits and response headers',
    reason:
      'route handlers are invoked directly with the request body/query; owned by the server host',
  },
  {
    area: 'Authentication and accounts (auth.js, authlib.js, register.js, passport/Steam, tokens, passwords, e-mail)',
    reason: 'credential handling is host-owned; the game keeps credential-free state',
  },
  {
    area: 'Socket.io/SockJS live updates (game/socket/*), pubsub fan-out, console streaming',
    reason: 'transport and subscription delivery are server-host features',
  },
  {
    area: 'CLI server/sandbox (cli/server.js, cli/sandbox.js, cli/help.js) and system.js pause/resume/tick duration/server messages/resetAllData',
    reason: 'operator transport and main-loop control live in the server host',
  },
  {
    area: 'Map image assets (updateRoomImageAssets PNGs) and env.terrainData cache (updateTerrainData)',
    reason: 'derived host caches; the game exposes world.terrain and the server rebuilds caches',
  },
  {
    area: 'Notification e-mail rendering/delivery (config.backend sendUserNotifications listeners)',
    reason:
      'delivery is host-owned; the runner compares which users are notified and the resulting state',
  },
  {
    area: 'Badge SVG rendering (badge.js), leaderboard HTTP endpoints, user messages, user console, memory/segment HTTP endpoints',
    reason: 'presentation/transport endpoints without a game-world rule in game/src',
  },
  {
    area: 'Live MMO features absent from the pinned backend (shards, intershard portals, subscriptions, CPU unlocks, pixels/decorations, seasonal events)',
    reason: 'not implemented by the pinned backend-local, so there is no original to execute',
  },
  {
    area: 'Driver-owned inputs (env.accessibleRooms, room status data, tick loop)',
    reason:
      'the driver is not part of the backend; when a backend job reads such a value the scenario writes it from the same world state with the driver rule cited in the scenario',
  },
];
