# Kittune Architecture

This document describes the code and data layout in this repository. It is intended to help a new engineer find the right place to make a change.

## At a glance

Kittune has two runtime parts:

1. **Client (`client/`)** — a React and TypeScript web app. It renders the host and player screens, plays the current audio preview, and sends player actions to SpacetimeDB.
2. **Server module (`server/spacetimedb/`)** — a Rust module compiled to WebAssembly and hosted by SpacetimeDB. It owns the authoritative game rules and game data. Reducers validate actions and update tables; views expose only the data each connected client needs.

There is no separate Express/API server. The client connects to SpacetimeDB over its client SDK and receives subscribed view updates in real time. The database module, not the browser, decides whether a guess is correct, whether a player can buzz, how scores change, and when a round ends.

The root `cre/` directory is a separate song-search utility; it is not part of the live game flow.

## Repository map

| Path | What it is for |
| --- | --- |
| `README.md` | Setup, local run, and Maincloud publishing instructions. |
| `ARCHITECTURE.md` | This code and data ownership map. |
| `.gitignore` | Excludes build output, dependencies, local environment files, and a Codex scratch folder. |
| `client/` | Browser app and its build configuration. |
| `server/` | SpacetimeDB module, seed data, and database target configuration. |
| `cre/` | Standalone Python song picker. |
| `files-pasted-by-the-user-you/` | Local Codex scratch/attachment material. It is ignored by Git and is not application source. |

Generated or installed folders such as `client/node_modules/`, `client/dist/`, and `server/spacetimedb/target/` are not source of truth. They can be recreated from the package and Rust manifests.

## Client: `client/`

Client code controls presentation and user interaction. It may keep temporary UI state, but it is not trusted to enforce game rules or store authoritative scores and room state.

| File or folder | Responsibility |
| --- | --- |
| `package.json` / `package-lock.json` | JavaScript dependencies and npm scripts (`npm run dev`, `npm run build`). |
| `index.html` | Browser document shell; loads `src/main.tsx` into the `#app` element. |
| `vite.config.ts` | Vite and React plugin configuration. |
| `tsconfig.json` | TypeScript compiler settings. |
| `.env.local` | Per-machine SpacetimeDB URL and database name. This file is intentionally ignored by Git; set it locally and restart Vite after changing it. Local testing uses `ws://127.0.0.1:3000` and the local database name; a cloud deployment uses the Maincloud WebSocket URL and its database name. |
| `src/main.tsx` | Actual application entry point. Builds the SpacetimeDB connection from the `VITE_SPACETIMEDB_*` variables, installs the React provider, and renders `App`. |
| `src/App.tsx` | Landing page and top-level switch between the host and player flows. |
| `src/views/HostView.tsx` | Host setup (including song-list selection and preview quality note), lobby, audio playback, scoreboard, buzzer, round display, and host-side reducer calls/subscriptions. |
| `src/views/PlayerView.tsx` | Player join flow, public room list, player game screen, buzzer, scoreboard, skip control, and player-side reducer calls/subscriptions. |
| `src/components/SongSearchModal.tsx` | Guess dialog. Searches iTunes from the browser and returns the selected track ID to the client view, which submits it to the server for validation. |
| `src/style.css` | Shared layout, component, responsive, and visual styles. |
| `src/module_bindings/` | Generated TypeScript definitions for the module's reducers, views, rows, and database connection. Regenerate after changing the server API; do not hand-edit generated bindings. |
| `src/assets/` and `public/` | Images, icons, and static files used by the UI. `Tunee.png` is used by the landing page. |
| `src/main.ts` / `src/counter.ts` | Leftover Vite starter example. `index.html` loads `main.tsx`, so these files are not the running app entry point. |

### What belongs in client changes?

Use the client for screen layout, styling, audio element behavior, search/selection UI, local form state, loading states, and user-facing errors. Client code calls server reducers to request changes and reads server views to render current state. Do not rely on client-only checks for permissions, correct answers, score changes, skip thresholds, or game progression; a modified browser could bypass those checks.

## Server: `server/`

### Configuration and dependencies

| File or folder | Responsibility |
| --- | --- |
| `spacetime.json` | Shared SpacetimeDB module path and default server target. Publishing commands should specify the intended target explicitly (`--server local` for local testing or Maincloud for the deployed database). |
| `spacetime.local.json` | Local target's database name (`kittune`). Each engineer's local SpacetimeDB server has its own independent database, even when the database name is the same. |
| `spacetimedb/Cargo.toml` | Rust module package metadata and direct dependencies. |
| `spacetimedb/Cargo.lock` | Locked Rust dependency versions for reproducible module builds. |
| `spacetimedb/src/lib.rs` | Server tables, views, reducers, seed loading, game rules, and round lifecycle. This is the main backend implementation file. |
| `seeds/seed_catalog.json` | Bundled Top 1000 song metadata, including the iTunes preview URLs. |
| `seeds/seed_nursery_rhymes.json` | One selected iTunes recording and preview URL for each nursery rhyme in that list. |
| `seeds/seed_movie_soundtracks.json` | Thirty iTunes tracks featured in popular movie soundtracks. |
| `seeds/seed_2010s_hits.json` | Thirty iTunes tracks released during the 2010s. |
| `seeds/seed_kpop.json` | Thirty K-pop tracks with English or Latin-script track titles. |
| `AGENTS.md` / `CLAUDE.md` | SpacetimeDB and coding-agent reference notes; these are guidance documents, not runtime code. |

### Data stored by the module

The table definitions are in `server/spacetimedb/src/lib.rs`. SpacetimeDB tables are private by default; client-readable data is exposed through explicit views.

| Table | Data it stores | Purpose |
| --- | --- | --- |
| `room` | Room code, host identity, status, visibility, capacity, target score, round number, winner, lifecycle timestamps, and selected catalog ID. | Persistent room/game settings and current game status. |
| `player` | Player identity, room code, display name, base score plus score adjustment, correct streak, current-song lockout, and elimination status. | Membership and per-player game state. Reaching −3 eliminates a player from buzzer and skip actions for that room. The view calculates effective score; online presence is tracked separately. |
| `presence_session` | A SpacetimeDB connection ID and the identity using that connection. | Temporary connection-level presence. Multiple sessions can belong to one identity, so a player stays online while any of their tabs/devices remain connected. A disconnect removes only that connection's row; it does not remove room membership or score. |
| `round_state` | Current audio and artwork URLs, buzzer owner/name/time, revealed track/artist fields, and the latest guess outcome. | One current-round snapshot per room. Answers are revealed to clients only when the room is over for that round/game; guess outcomes are shared briefly with the room. |
| `skip_vote` | One identity-keyed vote, room code, and round number. | Tracks which players have voted to skip the current song. Skip unanimity is evaluated among distinct connected room players; offline members and their old votes do not count toward the current threshold. |
| `song_secret` | Current room's track ID, correct name, artist, and room association. | Private answer key used to validate guesses and reveal a track after the round. |
| `catalog_song` | Track ID, name, artist, preview URL, and artwork URL (the legacy slot field remains for compatibility). | Private shared track metadata. New rows are added only when missing; list membership and per-list order live in `song_catalog_entry`. |
| `song_catalog` | Stable catalog ID, display name, description, and preview quality note. | Defines the song lists hosts can choose from; seeded lists are registered idempotently without clearing existing data. |
| `song_catalog_entry` | Catalog ID, position, and track ID. | Maps tracks into lists independently of global track metadata, allowing future lists to share tracks. |
| `song_order` | Shuffled track IDs for a room. | Keeps the room's song deck in order and avoids repeats until the catalog cycles. |
| `room_cleanup_timer` | Scheduled timer record. | Runs periodic cleanup of rooms whose host heartbeat has gone stale. |

### Views: data read by clients

Views in `lib.rs` are the client-facing read interface. They scope room data to the caller's room and shape private table rows into safe projections.

| View | Client purpose |
| --- | --- |
| `public_lobbies` | Anonymous list of joinable public rooms and occupancy. |
| `available_song_catalogs` | Public list names, descriptions, and quality notes for the host setup selector. |
| `my_room` | The caller's room status and public settings. |
| `players_in_my_room` | Room roster, effective scores, and an `online` value derived from `presence_session`. |
| `skip_votes_for_my_room` | Current room's skip votes. |
| `round_state_for_my_room` | Artwork, buzzer state, and answer fields after the reveal. |
| `host_round_audio` | Host's audio URL and track ID. |
| `player_round_audio` | Player's audio URL without the correct track ID. |

### Reducers: authoritative game actions

Reducers in `lib.rs` are transactional server operations. They validate the caller and current room state before changing data.

| Reducer | Responsibility |
| --- | --- |
| `init` | Seeds an empty catalog and schedules stale-room cleanup. |
| `track_client_connection`, `clear_client_connection` | Lifecycle reducers that insert/remove connection-level presence rows. Connects and disconnects both recheck whether the online-player skip quorum is already met. |
| `create_room`, `create_room_with_catalog`, `join_room`, `join_public_room`, `quit_room` | Create rooms (the legacy reducer defaults to Top 1000; the host UI calls the catalog-aware reducer), add players, or leave a room. A host leaving removes the room and its game data. |
| `host_heartbeat`, `cleanup_stale_rooms` | Keep host activity current and remove abandoned rooms. |
| `start_game`, `next_round`, `song_ended`, `end_game` | Start/progress/end games and reveal tracks at the right time. |
| `buzz_in`, `submit_guess`, `guess_timeout` | Enforce buzzer ownership, validate guesses, apply the −1 penalty for wrong guesses and timeouts, update lockouts, eliminate players at −3, end the game if no active players remain, and handle the guess timer. |
| `vote_skip` | Record a player's skip vote and end the round once all online players have voted. |

Private helpers in the same file register bundled catalogs and their membership rows idempotently, shuffle only the selected room catalog, and handle room authorization, scoring, round-song setup, and skip/guess resolution. `room.catalog_id` is appended with a `top-1000` default so existing rooms retain their original list after a compatible publish. Add future lists as JSON seed files and entries in the module's bundled catalog registry; keep reusable track metadata in `catalog_song` and list membership in `song_catalog_entry`.

### What belongs in server changes?

Put game rules and authoritative writes in the Rust module: validation, score changes, correct-answer checks, player permissions, room/round transitions, and server-owned data changes. The client should request these operations through reducers and react to their resulting view updates.

Changing a reducer or view changes the client/server API. Regenerate `client/src/module_bindings/` after such changes. Changing a table or its columns changes the database schema; treat that as a migration and follow the publish output carefully, especially on Maincloud. Publishing to a database updates that database's module; publishing to local does not update Maincloud.

The known score compatibility case is already handled in code: keep `player.score` as the deployed `u32` field in its existing position, and store signed adjustments in the appended `score_delta: i64` field with a default of zero. This avoids rewriting existing scores while supporting negative totals. For a future incompatible table redesign, use an incremental migration: add a replacement table, copy rows with an idempotent server-side migration reducer, switch reducers/views to the replacement, verify the data, and only then remove the old table after it is empty. Publish each stage with data deletion disabled; do not use `--delete-data=always` as a migration step.

## Song data and the optional utility

The live game's bundled song catalogs are defined in `server/spacetimedb/src/lib.rs` and their track metadata is stored in the corresponding JSON files under `server/seeds/`. The module registers each catalog and adds missing song and catalog-entry rows without deleting existing data. Changes to an already-registered catalog are not automatically applied to existing rows; plan an explicit data update rather than assuming a module publish will overwrite them.

`cre/song_picker.py` is separate from that seed flow. It searches Deezer and iTunes, selects a random result, and writes `cre/output/track.json` plus `cre/logs/song_picker.log` when run. It does not automatically add the selected song to any SpacetimeDB catalog. `cre/README.md` documents how to run it.

## Local and deployed configuration

- The browser's Vite origin and its database target are separate. Opening the app at `http://localhost:5173` does not by itself mean it is using a local database; the `VITE_SPACETIMEDB_URI` value in `client/.env.local` determines the backend host.
- `spacetime start` runs a local SpacetimeDB server. Publish the Rust module to that server for local tests. Each engineer's standalone server has its own data; matching database names do not make them shared.
- Maincloud is the shared remote database. Use an explicit target for publishing and verify the target/database name before any publish command.
- A client-only change affects the browser build/deployment. A server-only change takes effect in a database only after the updated module is published to that database. A feature involving both UI and game rules may require changes and deployment on both sides.

For the complete local setup commands and current operational instructions, see `README.md`.
