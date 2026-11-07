use serde::Deserialize;
use spacetimedb::{Identity, ReducerContext, Table, TimeDuration, Timestamp};

const STATUS_LOBBY: &str = "LOBBY";
const STATUS_PLAYING: &str = "PLAYING";
const STATUS_PAUSED: &str = "PAUSED_FOR_GUESS";
const STATUS_ROUND_OVER: &str = "ROUND_OVER";
const STATUS_GAME_OVER: &str = "GAME_OVER";
const GUESS_WINDOW_MICROS: i64 = 5_000_000;

#[spacetimedb::table(accessor = room, public)]
pub struct Room {
    #[primary_key]
    pub code: String,
    pub host_identity: Identity,
    pub status: String,
    pub target_score: u32,
    pub current_round: u32,
    pub winner_name: Option<String>,
}

#[spacetimedb::table(accessor = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub room_code: String,
    pub name: String,
    pub score: u32,
    pub locked_out_this_round: bool,
}

#[spacetimedb::table(accessor = round_state, public)]
pub struct RoundState {
    #[primary_key]
    pub room_code: String,
    pub audio_url: String,
    pub artwork_url: String,
    pub locked_by: Option<Identity>,
    pub locked_by_name: Option<String>,
    pub buzz_timestamp: Option<Timestamp>,
    #[default(None)]
    pub revealed_track_name: Option<String>,
    #[default(None)]
    pub revealed_artist_name: Option<String>,
}

// Private by default: neither secrets nor the catalog can be subscribed to by clients.
#[spacetimedb::table(accessor = song_secret)]
pub struct SongSecret {
    #[primary_key]
    #[auto_inc]
    pub id: u32,
    #[index(btree)]
    pub room_code: String,
    pub track_id: i64,
    pub track_name: String,
    pub artist_name: String,
}

#[spacetimedb::table(accessor = catalog_song)]
pub struct CatalogSong {
    #[primary_key]
    pub track_id: i64,
    #[index(btree)]
    pub slot: u32,
    pub track_name: String,
    pub artist_name: String,
    pub preview_url: String,
    pub artwork_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedSong {
    track_id: i64,
    track_name: String,
    artist_name: String,
    preview_url: String,
    artwork_url: String,
}

fn ensure_catalog(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.catalog_song().count() > 0 {
        return Ok(());
    }

    let seeds: Vec<SeedSong> = serde_json::from_str(include_str!("../../seeds/seed_catalog.json"))
        .map_err(|error| format!("Could not read bundled song catalog: {error}"))?;
    if seeds.len() < 15 {
        return Err("The bundled catalog must contain at least 15 songs".into());
    }

    for (slot, seed) in seeds.into_iter().enumerate() {
        ctx.db.catalog_song().insert(CatalogSong {
            track_id: seed.track_id,
            slot: slot as u32,
            track_name: seed.track_name,
            artist_name: seed.artist_name,
            preview_url: seed.preview_url,
            artwork_url: seed.artwork_url,
        });
    }
    Ok(())
}

fn song_for_round(ctx: &ReducerContext, round: u32) -> Result<CatalogSong, String> {
    ensure_catalog(ctx)?;
    let count = ctx.db.catalog_song().count() as u32;
    if count == 0 {
        return Err("The song catalog is empty".into());
    }
    let slot = round % count;
    ctx.db
        .catalog_song()
        .slot()
        .filter(slot)
        .next()
        .ok_or_else(|| "No catalog song found for this round".into())
}

fn set_round_song(ctx: &ReducerContext, room_code: &str, round: u32) -> Result<(), String> {
    let song = song_for_round(ctx, round)?;
    ctx.db.song_secret().room_code().delete(room_code);
    ctx.db.song_secret().insert(SongSecret {
        id: 0,
        room_code: room_code.to_string(),
        track_id: song.track_id,
        track_name: song.track_name,
        artist_name: song.artist_name,
    });

    let state = RoundState {
        room_code: room_code.to_string(),
        audio_url: song.preview_url,
        artwork_url: song.artwork_url,
        locked_by: None,
        locked_by_name: None,
        buzz_timestamp: None,
        revealed_track_name: None,
        revealed_artist_name: None,
    };
    if ctx.db.round_state().room_code().find(room_code.to_string()).is_some() {
        ctx.db.round_state().room_code().update(state);
    } else {
        ctx.db.round_state().insert(state);
    }
    Ok(())
}

fn require_host(ctx: &ReducerContext, room: &Room) -> Result<(), String> {
    if room.host_identity != ctx.sender() {
        return Err("Only the room host can do that".into());
    }
    Ok(())
}

fn expire_guess(ctx: &ReducerContext, room_code: &str) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code.to_string())
        .ok_or_else(|| "Room not found".to_string())?;
    if room.status != STATUS_PAUSED {
        return Err("There is no active guess to time out".into());
    }
    let mut state = ctx
        .db
        .round_state()
        .room_code()
        .find(room_code.to_string())
        .ok_or_else(|| "Round state not found".to_string())?;
    let identity = state
        .locked_by
        .ok_or_else(|| "No player has the buzzer".to_string())?;
    let mut player = ctx
        .db
        .player()
        .identity()
        .find(identity)
        .ok_or_else(|| "Buzzing player not found".to_string())?;
    player.locked_out_this_round = true;
    ctx.db.player().identity().update(player);

    state.locked_by = None;
    state.locked_by_name = None;
    state.buzz_timestamp = None;
    ctx.db.round_state().room_code().update(state);

    let updated_room = Room { status: STATUS_PLAYING.to_string(), ..room };
    ctx.db.room().code().update(updated_room);
    Ok(())
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) -> Result<(), String> {
    ensure_catalog(ctx)
}

#[spacetimedb::reducer]
pub fn create_room(ctx: &ReducerContext, code: String, target_score: u32) -> Result<(), String> {
    if code.len() != 4 || !code.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("Room code must be exactly four uppercase letters".into());
    }
    if target_score == 0 || target_score > 100 {
        return Err("Target score must be between 1 and 100".into());
    }
    if ctx.db.room().code().find(code.clone()).is_some() {
        return Err("That room code is already in use".into());
    }
    ctx.db.room().insert(Room {
        code,
        host_identity: ctx.sender(),
        status: STATUS_LOBBY.to_string(),
        target_score,
        current_round: 0,
        winner_name: None,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn join_room(ctx: &ReducerContext, code: String, name: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    if room.status != STATUS_LOBBY {
        return Err("This room has already started".into());
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 24 {
        return Err("Player name must be between 1 and 24 characters".into());
    }
    if ctx.db.player().identity().find(ctx.sender()).is_some() {
        return Err("This identity has already joined a room".into());
    }
    ctx.db.player().insert(Player {
        identity: ctx.sender(),
        room_code: code,
        name: name.to_string(),
        score: 0,
        locked_out_this_round: false,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn start_game(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    require_host(ctx, &room)?;
    if room.status != STATUS_LOBBY {
        return Err("The game is not in the lobby".into());
    }
    if ctx.db.player().room_code().filter(&room_code).next().is_none() {
        return Err("At least one player must join before starting".into());
    }
    set_round_song(ctx, &room_code, room.current_round)?;
    ctx.db.room().code().update(Room { status: STATUS_PLAYING.to_string(), ..room });
    Ok(())
}

#[spacetimedb::reducer]
pub fn buzz_in(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    if room.status != STATUS_PLAYING {
        return Err("The song is not accepting buzzes".into());
    }
    let mut state = ctx
        .db
        .round_state()
        .room_code()
        .find(room_code.clone())
        .ok_or_else(|| "Round state not found".to_string())?;
    if state.locked_by.is_some() {
        return Err("Another player already has the buzzer".into());
    }
    let player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "Join this room before buzzing".to_string())?;
    if player.room_code != room_code {
        return Err("You are not a member of this room".into());
    }
    if player.locked_out_this_round {
        return Err("You are locked out for this song".into());
    }
    state.locked_by = Some(ctx.sender());
    state.locked_by_name = Some(player.name.clone());
    state.buzz_timestamp = Some(ctx.timestamp);
    ctx.db.round_state().room_code().update(state);
    ctx.db.room().code().update(Room { status: STATUS_PAUSED.to_string(), ..room });
    Ok(())
}

#[spacetimedb::reducer]
pub fn submit_guess(ctx: &ReducerContext, room_code: String, guessed_track_id: i64) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    if room.status != STATUS_PAUSED {
        return Err("There is no active guess".into());
    }
    let state = ctx
        .db
        .round_state()
        .room_code()
        .find(room_code.clone())
        .ok_or_else(|| "Round state not found".to_string())?;
    if state.locked_by != Some(ctx.sender()) {
        return Err("Only the player with the buzzer can submit a guess".into());
    }
    let started_at = state.buzz_timestamp.ok_or_else(|| "Guess timer is missing".to_string())?;
    if ctx.timestamp >= started_at + TimeDuration::from_micros(GUESS_WINDOW_MICROS) {
        expire_guess(ctx, &room_code)?;
        return Ok(());
    }

    let player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "Player not found".to_string())?;
    let secret = ctx
        .db
        .song_secret()
        .room_code()
        .filter(&room_code)
        .next()
        .ok_or_else(|| "Song secret not found".to_string())?;

    if guessed_track_id == secret.track_id {
        let score = player.score + 1;
        let player_name = player.name.clone();
        ctx.db.player().identity().update(Player { score, ..player });
        ctx.db.round_state().room_code().update(RoundState {
            revealed_track_name: Some(secret.track_name),
            revealed_artist_name: Some(secret.artist_name),
            ..state
        });
        if score >= room.target_score {
            ctx.db.room().code().update(Room {
                status: STATUS_GAME_OVER.to_string(),
                winner_name: Some(player_name),
                ..room
            });
        } else {
            ctx.db.room().code().update(Room { status: STATUS_ROUND_OVER.to_string(), ..room });
        }
    } else {
        let player = Player { locked_out_this_round: true, ..player };
        ctx.db.player().identity().update(player);
        let mut state = state;
        state.locked_by = None;
        state.locked_by_name = None;
        state.buzz_timestamp = None;
        ctx.db.round_state().room_code().update(state);
        ctx.db.room().code().update(Room { status: STATUS_PLAYING.to_string(), ..room });
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn guess_timeout(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let state = ctx
        .db
        .round_state()
        .room_code()
        .find(room_code.clone())
        .ok_or_else(|| "Round state not found".to_string())?;
    let started_at = state.buzz_timestamp.ok_or_else(|| "Guess timer is missing".to_string())?;
    if ctx.timestamp < started_at + TimeDuration::from_micros(GUESS_WINDOW_MICROS) {
        return Err("The five-second guess window has not expired".into());
    }
    expire_guess(ctx, &room_code)
}

#[spacetimedb::reducer]
pub fn song_ended(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code)
        .ok_or_else(|| "Room not found".to_string())?;
    require_host(ctx, &room)?;
    if room.status != STATUS_PLAYING {
        return Err("The song cannot end in the current game state".into());
    }
    let mut state = ctx
        .db
        .round_state()
        .room_code()
        .find(room.code.clone())
        .ok_or_else(|| "Round state not found".to_string())?;
    let secret = ctx
        .db
        .song_secret()
        .room_code()
        .filter(&room.code)
        .next()
        .ok_or_else(|| "Song secret not found".to_string())?;
    state.revealed_track_name = Some(secret.track_name);
    state.revealed_artist_name = Some(secret.artist_name);
    ctx.db.round_state().room_code().update(state);
    ctx.db.room().code().update(Room { status: STATUS_ROUND_OVER.to_string(), ..room });
    Ok(())
}

#[spacetimedb::reducer]
pub fn next_round(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    require_host(ctx, &room)?;
    if room.status != STATUS_ROUND_OVER {
        return Err("The current round is not over".into());
    }
    let next = room.current_round + 1;
    set_round_song(ctx, &room_code, next)?;
    for player in ctx.db.player().room_code().filter(&room_code) {
        if player.locked_out_this_round {
            ctx.db.player().identity().update(Player { locked_out_this_round: false, ..player });
        }
    }
    ctx.db.room().code().update(Room {
        status: STATUS_PLAYING.to_string(),
        current_round: next,
        ..room
    });
    Ok(())
}
