# Kittune

Kittune is a real-time multiplayer music-guessing game. The host runs the audio and scoreboard; players join with a four-letter room code and use their phones or a second browser session as buzzers.

## Requirements

- SpacetimeDB CLI 2.14.1
- Rust stable with the `wasm32-unknown-unknown` target
- Node.js 22 or newer

Install the Rust target once if needed:

```sh
rustup target add wasm32-unknown-unknown
```

## Run locally

Open two terminals in the repository.

In terminal 1, start the local SpacetimeDB server and leave it running:

```sh
spacetime start
```

In terminal 2, publish the module, generate TypeScript bindings, and start Vite:

```sh
cd server
spacetime publish kittune --server local
spacetime generate --lang typescript --out-dir ../client/src/module_bindings --module-path ./spacetimedb
cd ../client
npm install
npm run dev
```

Open `http://localhost:5173/`. Choose **Host a room** on the display, then use a separate browser profile or incognito window on the same computer to join with the room code. Start the game after the player appears in the lobby.

Both services bind to the local machine by default. Connecting from a phone or another computer requires configuring network access separately.

## Optional song picker

The `cre` directory contains a standalone Python song-picker utility. See [cre/README.md](cre/README.md) for its usage.
