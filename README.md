<!-- @format -->

# Kittune

Kittune is a real-time multiplayer music-guessing game. The host runs the audio and scoreboard; players join with a four-letter room code and use their phones or a second browser session as buzzers.

## Requirements

- SpacetimeDB CLI 2.14.1
- Rust stable with the `wasm32-unknown-unknown` target
- Node.js 22 or newer

### Install SpacetimeDB CLI

macOS / Linux:

```sh
curl -sSf https://install.spacetimedb.com | sh
```

Windows (PowerShell):

```powershell
iwr https://windows.spacetimedb.com -useb | iex
```

Open a new terminal, then check the version. If it isn't 2.14.1, switch to it:

```sh
spacetime --version
spacetime version list
spacetime version use 2.14.1
```

### Install Rust (stable) and the WebAssembly target

Install `rustup`, the Rust toolchain manager, from <https://rustup.rs>. On macOS / Linux:

```sh
curl https://sh.rustup.rs -sSf | sh
```

On Windows, download and run `rustup-init.exe` from the same page.

Then make sure the stable toolchain is the default and add the WebAssembly target:

```sh
rustup default stable
rustup target add wasm32-unknown-unknown
```

Verify:

```sh
rustc --version
rustup target list --installed
```

### Install Node.js 22

Download the Node.js 22 (LTS) installer from <https://nodejs.org>, or use a version manager:

```sh
# nvm (macOS / Linux) or nvm-windows
nvm install 22
nvm use 22
```

Verify:

```sh
node --version
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

Open `http://localhost:5173/`. Choose **Host a room** on the display, enter a display name and the points needed to win (1–100, default 3), choose whether the room is private or public, select a song list, and create it. Private rooms are joined by code; public rooms appear in the live public-games list. The host is added as a player and can buzz in from the host display. Start the game when everyone is in the lobby. The Nursery Rhymes list uses one selected recording per rhyme; many versions sound alike, and short previews can be generic or uneven.

Each game uses a shuffled catalog deck, so songs are random and do not repeat until the catalog has cycled. Players have 15 seconds to submit a guess after buzzing in. Host and player screens show whether each guess was correct, wrong, or timed out. Song details and artwork are revealed on both screens when the preview ends or a correct guess is submitted, then the next round starts automatically after a five-second reveal.

Players can vote to skip an active song; the round ends and reveals the track once every online player in the room has voted. A disconnected player's vote is not required, and the remaining online vote count is rechecked when a player disconnects.

An incorrect guess deducts one point (scores can go negative); reaching −3 points eliminates a player from buzzer and skip play for that room. The game ends without a winner when no active players remain. The Quit button removes a player from the room, or deletes the room when used by its host, then returns them home. Three or more consecutive correct guesses display a fire marker by the player's name.

Both services bind to the local machine by default. Connecting from a phone or another computer requires configuring network access separately.

## Update the cloud module without deleting data

From the `server` directory, publish to the cloud database explicitly; the repository configuration may default to the local server:

```powershell
spacetime publish kittune-paperbagtrick-2026 --server "https://maincloud.spacetimedb.com" --delete-data=never
```

The current module preserves the existing `player` column order and unsigned score column, adding a signed score adjustment with a zero default and an `eliminated` flag with a false default after the existing fields. Existing rows remain migratable. If publishing reports a schema or migration error, stop and resolve it before retrying; do not use a data-deletion option.

## Optional song picker

The `cre` directory contains a standalone Python song-picker utility. See [cre/README.md](cre/README.md) for its usage.
