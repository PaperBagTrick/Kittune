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

Open `http://localhost:5173/`. Choose **Host a room** on the display, enter a display name and the points needed to win (1–100, default 5), and create the room. The host is added as a player and can buzz in from the host display; other players can join with the room code from their phones or another browser. Start the game when everyone is in the lobby.

Each game uses a shuffled catalog deck, so songs are random and do not repeat until the catalog has cycled. Players have 10 seconds to submit a guess after buzzing in. Song details and artwork are revealed on both the host display and player screens when the preview ends or a correct guess is submitted, then the next round starts automatically after a five-second reveal.

Players can vote to skip an active song; the round ends and reveals the track once every player in the room has voted.

An incorrect guess deducts one point (scores can go negative). Three or more consecutive correct guesses display a fire marker by the player's name.

Both services bind to the local machine by default. Connecting from a phone or another computer requires configuring network access separately.

## Optional song picker

The `cre` directory contains a standalone Python song-picker utility. See [cre/README.md](cre/README.md) for its usage.
