use serde::Deserialize;
use spacetimedb::{
    AnonymousViewContext, Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, TimeDuration,
    Timestamp, ViewContext,
    rand::{Rng, SeedableRng, rngs::StdRng},
};
use std::time::Duration;

const STATUS_LOBBY: &str = "LOBBY";
const STATUS_PLAYING: &str = "PLAYING";
const STATUS_PAUSED: &str = "PAUSED_FOR_GUESS";
const STATUS_ROUND_OVER: &str = "ROUND_OVER";
const STATUS_GAME_OVER: &str = "GAME_OVER";
const GUESS_WINDOW_MICROS: i64 = 10_000_000;
const DEFAULT_MAX_PLAYERS: u32 = 8;
const MIN_MAX_PLAYERS: u32 = 2;
const MAX_MAX_PLAYERS: u32 = 12;
const HOST_STALE_MICROS: i64 = 300_000_000;

#[spacetimedb::table(accessor = room)]
pub struct Room {
    #[primary_key]
    pub code: String,
    #[index(btree)]
    pub host_identity: Identity,
    pub status: String,
    pub target_score: u32,
    pub current_round: u32,
    pub winner_name: Option<String>,
    #[default("PRIVATE")]
    #[index(btree)]
    pub visibility: String,
    #[default(8)]
    pub max_players: u32,
    #[default(None)]
    pub created_at: Option<Timestamp>,
    #[default(None)]
    pub last_host_seen: Option<Timestamp>,
}

#[spacetimedb::table(accessor = player)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub room_code: String,
    pub name: String,
    pub score: u32,
    pub locked_out_this_round: bool,
    #[default(0)]
    pub correct_streak: u32,
    #[default(0)]
    pub score_delta: i64,
}

#[spacetimedb::table(accessor = round_state)]
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

#[derive(SpacetimeType)]
pub struct PublicLobby {
    pub code: String,
    pub player_count: u32,
    pub max_players: u32,
    pub target_score: u32,
    pub created_at: Option<Timestamp>,
}

#[derive(SpacetimeType)]
pub struct RoomView {
    pub code: String,
    pub host_identity: Identity,
    pub status: String,
    pub visibility: String,
    pub max_players: u32,
    pub target_score: u32,
    pub current_round: u32,
    pub winner_name: Option<String>,
}

#[derive(SpacetimeType)]
pub struct PlayerView {
    pub identity: Identity,
    pub room_code: String,
    pub name: String,
    pub score: i64,
    pub locked_out_this_round: bool,
    pub correct_streak: u32,
}

#[derive(SpacetimeType)]
pub struct RoundView {
    pub room_code: String,
    pub artwork_url: String,
    pub locked_by: Option<Identity>,
    pub locked_by_name: Option<String>,
    pub buzz_timestamp: Option<Timestamp>,
    pub revealed_track_name: Option<String>,
    pub revealed_artist_name: Option<String>,
}

#[derive(SpacetimeType)]
pub struct HostRoundAudio {
    pub room_code: String,
    pub audio_url: String,
    pub track_id: i64,
}

#[derive(SpacetimeType)]
pub struct PlayerRoundAudio {
    pub room_code: String,
    pub audio_url: String,
}

#[spacetimedb::table(accessor = room_cleanup_timer, scheduled(cleanup_stale_rooms))]
pub struct RoomCleanupTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::table(accessor = skip_vote)]
pub struct SkipVote {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub room_code: String,
    pub round: u32,
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

#[spacetimedb::table(accessor = song_order)]
pub struct SongOrder {
    #[primary_key]
    pub room_code: String,
    pub track_ids: Vec<i64>,
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

fn room_for_sender(ctx: &ViewContext) -> Option<Room> {
    if let Some(player) = ctx.db.player().identity().find(ctx.sender()) {
        return ctx.db.room().code().find(player.room_code);
    }
    ctx.db.room().host_identity().filter(ctx.sender()).next()
}

fn effective_score(player: &Player) -> i64 {
    i64::from(player.score) + player.score_delta
}

fn adjust_score(player: &mut Player, change: i64) -> Result<i64, String> {
    let score_delta = player
        .score_delta
        .checked_add(change)
        .ok_or_else(|| "Score is out of range".to_string())?;
    let score = i64::from(player.score)
        .checked_add(score_delta)
        .ok_or_else(|| "Score is out of range".to_string())?;
    player.score_delta = score_delta;
    Ok(score)
}

#[spacetimedb::view(accessor = public_lobbies, public, primary_key = code)]
pub fn public_lobbies(ctx: &AnonymousViewContext) -> Vec<PublicLobby> {
    let public_visibility = "PUBLIC".to_string();
    ctx.db
        .room()
        .visibility()
        .filter(&public_visibility)
        .filter(|room| room.status == STATUS_LOBBY)
        .filter_map(|room| {
            let player_count = ctx.db.player().room_code().filter(&room.code).count() as u32;
            (player_count < room.max_players).then_some(PublicLobby {
                code: room.code,
                player_count,
                max_players: room.max_players,
                target_score: room.target_score,
                created_at: room.created_at,
            })
        })
        .collect()
}

#[spacetimedb::view(accessor = my_room, public, primary_key = code)]
pub fn my_room(ctx: &ViewContext) -> Vec<RoomView> {
    room_for_sender(ctx)
        .map(|room| {
            vec![RoomView {
                code: room.code,
                host_identity: room.host_identity,
                status: room.status,
                visibility: room.visibility,
                max_players: room.max_players,
                target_score: room.target_score,
                current_round: room.current_round,
                winner_name: room.winner_name,
            }]
        })
        .unwrap_or_default()
}

#[spacetimedb::view(accessor = players_in_my_room, public, primary_key = identity)]
pub fn players_in_my_room(ctx: &ViewContext) -> Vec<PlayerView> {
    room_for_sender(ctx)
        .map(|room| {
            ctx.db
                .player()
                .room_code()
                .filter(&room.code)
                .map(|player| {
                    let score = effective_score(&player);
                    PlayerView {
                        identity: player.identity,
                        room_code: player.room_code,
                        name: player.name,
                        score,
                        locked_out_this_round: player.locked_out_this_round,
                        correct_streak: player.correct_streak,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[spacetimedb::view(accessor = skip_votes_for_my_room, public, primary_key = identity)]
pub fn skip_votes_for_my_room(ctx: &ViewContext) -> Vec<SkipVote> {
    room_for_sender(ctx)
        .map(|room| ctx.db.skip_vote().room_code().filter(&room.code).collect())
        .unwrap_or_default()
}

#[spacetimedb::view(accessor = round_state_for_my_room, public, primary_key = room_code)]
pub fn round_state_for_my_room(ctx: &ViewContext) -> Vec<RoundView> {
    let Some(room) = room_for_sender(ctx) else {
        return Vec::new();
    };
    let Some(state) = ctx.db.round_state().room_code().find(room.code.clone()) else {
        return Vec::new();
    };
    let reveal_answer = matches!(room.status.as_str(), STATUS_ROUND_OVER | STATUS_GAME_OVER);
    vec![RoundView {
        room_code: state.room_code,
        artwork_url: state.artwork_url,
        locked_by: state.locked_by,
        locked_by_name: state.locked_by_name,
        buzz_timestamp: state.buzz_timestamp,
        revealed_track_name: reveal_answer.then_some(state.revealed_track_name).flatten(),
        revealed_artist_name: reveal_answer
            .then_some(state.revealed_artist_name)
            .flatten(),
    }]
}

#[spacetimedb::view(accessor = host_round_audio, public, primary_key = room_code)]
pub fn host_round_audio(ctx: &ViewContext) -> Vec<HostRoundAudio> {
    ctx.db
        .room()
        .host_identity()
        .filter(ctx.sender())
        .filter_map(|room| {
            ctx.db
                .round_state()
                .room_code()
                .find(room.code.clone())
                .map(|state| HostRoundAudio {
                    room_code: room.code.clone(),
                    audio_url: state.audio_url,
                    track_id: ctx
                        .db
                        .song_secret()
                        .room_code()
                        .filter(&room.code)
                        .next()
                        .map(|song| song.track_id)
                        .unwrap_or_default(),
                })
        })
        .collect()
}

fn delete_room_data(ctx: &ReducerContext, room_code: &str) {
    let code = room_code.to_string();
    let players: Vec<Player> = ctx.db.player().room_code().filter(&code).collect();
    for player in players {
        ctx.db.player().identity().delete(player.identity);
    }
    let votes: Vec<SkipVote> = ctx.db.skip_vote().room_code().filter(&code).collect();
    for vote in votes {
        ctx.db.skip_vote().identity().delete(vote.identity);
    }
    ctx.db.round_state().room_code().delete(code.clone());
    ctx.db.song_secret().room_code().delete(&code);
    ctx.db.song_order().room_code().delete(&code);
    ctx.db.room().code().delete(code);
}

fn join_room_as(
    ctx: &ReducerContext,
    code: String,
    name: String,
    visibility: &str,
) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    if room.visibility != visibility {
        return Err(if visibility == "PUBLIC" {
            "That public game is no longer available"
        } else {
            "Use the public games list to join this room"
        }
        .into());
    }
    if room.status != STATUS_LOBBY {
        return Err("This room has already started".into());
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 24 {
        return Err("Player name must be between 1 and 24 characters".into());
    }
    if let Some(player) = ctx.db.player().identity().find(ctx.sender()) {
        return if player.room_code == code {
            Ok(())
        } else {
            Err("Leave your current game before joining another".into())
        };
    }
    if ctx
        .db
        .room()
        .host_identity()
        .filter(ctx.sender())
        .next()
        .is_some()
    {
        return Err("Leave your current hosted game before joining another".into());
    }
    let player_count = ctx.db.player().room_code().filter(&code).count() as u32;
    if player_count >= room.max_players {
        return Err("This game is full".into());
    }
    ctx.db.player().insert(Player {
        identity: ctx.sender(),
        room_code: code,
        name: name.to_string(),
        score: 0,
        locked_out_this_round: false,
        correct_streak: 0,
        score_delta: 0,
    });
    Ok(())
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

fn shuffled_track_ids(ctx: &ReducerContext, shuffle_seed: &str) -> Result<Vec<i64>, String> {
    ensure_catalog(ctx)?;
    let mut track_ids: Vec<i64> = ctx
        .db
        .catalog_song()
        .iter()
        .map(|song| song.track_id)
        .collect();
    if track_ids.is_empty() {
        return Err("The song catalog is empty".into());
    }
    if shuffle_seed.len() != 64 || !shuffle_seed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Shuffle seed must be 32 bytes encoded as hexadecimal".into());
    }
    let mut seed = [0; 32];
    for (index, pair) in shuffle_seed.as_bytes().chunks_exact(2).enumerate() {
        let byte =
            std::str::from_utf8(pair).map_err(|error| format!("Invalid shuffle seed: {error}"))?;
        seed[index] = u8::from_str_radix(byte, 16)
            .map_err(|error| format!("Invalid shuffle seed: {error}"))?;
    }
    let mut rng = StdRng::from_seed(seed);
    for index in (1..track_ids.len()).rev() {
        let swap_index = rng.gen_range(0..=index);
        track_ids.swap(index, swap_index);
    }
    Ok(track_ids)
}

fn set_round_song(
    ctx: &ReducerContext,
    room_code: &str,
    round: u32,
    shuffle_seed: &str,
) -> Result<(), String> {
    ensure_catalog(ctx)?;
    let count = ctx.db.catalog_song().count() as usize;
    if count == 0 {
        return Err("The song catalog is empty".into());
    }
    let has_song_order = ctx
        .db
        .song_order()
        .room_code()
        .find(room_code.to_string())
        .is_some();
    if round as usize % count == 0 || !has_song_order {
        let mut track_ids = shuffled_track_ids(ctx, shuffle_seed)?;
        let previous_track_id = ctx
            .db
            .song_secret()
            .room_code()
            .filter(room_code)
            .next()
            .map(|secret| secret.track_id);
        if track_ids.len() > 1 && track_ids.first() == previous_track_id.as_ref() {
            track_ids.swap(0, 1);
        }
        let order = SongOrder {
            room_code: room_code.to_string(),
            track_ids,
        };
        if ctx
            .db
            .song_order()
            .room_code()
            .find(room_code.to_string())
            .is_some()
        {
            ctx.db.song_order().room_code().update(order);
        } else {
            ctx.db.song_order().insert(order);
        }
    }
    let order = ctx
        .db
        .song_order()
        .room_code()
        .find(room_code.to_string())
        .ok_or_else(|| "Song order not found for this room".to_string())?;
    if order.track_ids.is_empty() {
        return Err("The song order is empty".into());
    }
    let track_id = order.track_ids[round as usize % order.track_ids.len()];
    let song = ctx
        .db
        .catalog_song()
        .track_id()
        .find(track_id)
        .ok_or_else(|| "No catalog song found for this round".to_string())?;
    for vote in ctx.db.skip_vote().room_code().filter(room_code) {
        ctx.db.skip_vote().identity().delete(vote.identity);
    }
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
    if ctx
        .db
        .round_state()
        .room_code()
        .find(room_code.to_string())
        .is_some()
    {
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

    let updated_room = Room {
        status: STATUS_PLAYING.to_string(),
        ..room
    };
    ctx.db.room().code().update(updated_room);
    Ok(())
}

#[spacetimedb::view(accessor = player_round_audio, public, primary_key = room_code)]
pub fn player_round_audio(ctx: &ViewContext) -> Vec<PlayerRoundAudio> {
    room_for_sender(ctx)
        .and_then(|room| {
            ctx.db
                .round_state()
                .room_code()
                .find(room.code)
                .map(|state| PlayerRoundAudio {
                    room_code: state.room_code,
                    audio_url: state.audio_url,
                })
        })
        .into_iter()
        .collect()
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) -> Result<(), String> {
    ensure_catalog(ctx)?;
    if ctx.db.room_cleanup_timer().count() == 0 {
        ctx.db.room_cleanup_timer().insert(RoomCleanupTimer {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Interval(Duration::from_secs(30).into()),
        });
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn create_room(
    ctx: &ReducerContext,
    code: String,
    target_score: u32,
    host_name: String,
    visibility: String,
    max_players: u32,
) -> Result<(), String> {
    if code.len() != 4 || !code.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("Room code must be exactly four uppercase letters".into());
    }
    if target_score == 0 || target_score > 100 {
        return Err("Target score must be between 1 and 100".into());
    }
    if visibility != "PRIVATE" && visibility != "PUBLIC" {
        return Err("Room visibility must be PUBLIC or PRIVATE".into());
    }
    let max_players = if max_players == 0 {
        DEFAULT_MAX_PLAYERS
    } else {
        max_players
    };
    if !(MIN_MAX_PLAYERS..=MAX_MAX_PLAYERS).contains(&max_players) {
        return Err(format!(
            "Room capacity must be between {MIN_MAX_PLAYERS} and {MAX_MAX_PLAYERS} players"
        ));
    }
    if ctx.db.player().identity().find(ctx.sender()).is_some() {
        return Err("This identity is already playing in a room.".into());
    }
    if ctx
        .db
        .room()
        .host_identity()
        .filter(ctx.sender())
        .next()
        .is_some()
    {
        return Err("You already host a room.".into());
    }
    if ctx.db.room().code().find(code.clone()).is_some() {
        return Err("That room code is already in use".into());
    }
    let host_name = host_name.trim();
    if host_name.is_empty() || host_name.chars().count() > 24 {
        return Err("Host display name must be between 1 and 24 characters".into());
    }
    ctx.db.room().insert(Room {
        code: code.clone(),
        host_identity: ctx.sender(),
        status: STATUS_LOBBY.to_string(),
        visibility,
        max_players,
        target_score,
        current_round: 0,
        winner_name: None,
        created_at: Some(ctx.timestamp),
        last_host_seen: Some(ctx.timestamp),
    });
    ctx.db.player().insert(Player {
        identity: ctx.sender(),
        room_code: code,
        name: host_name.to_string(),
        score: 0,
        locked_out_this_round: false,
        correct_streak: 0,
        score_delta: 0,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn join_room(ctx: &ReducerContext, code: String, name: String) -> Result<(), String> {
    join_room_as(ctx, code, name, "PRIVATE")
}

#[spacetimedb::reducer]
pub fn join_public_room(ctx: &ReducerContext, code: String, name: String) -> Result<(), String> {
    join_room_as(ctx, code, name, "PUBLIC")
}

#[spacetimedb::reducer]
pub fn host_heartbeat(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let mut room = ctx
        .db
        .room()
        .code()
        .find(room_code)
        .ok_or_else(|| "Room not found".to_string())?;
    require_host(ctx, &room)?;
    room.last_host_seen = Some(ctx.timestamp);
    ctx.db.room().code().update(room);
    Ok(())
}

#[spacetimedb::reducer]
pub fn cleanup_stale_rooms(ctx: &ReducerContext, _timer: RoomCleanupTimer) {
    let now = ctx.timestamp;
    let mut stale_rooms = Vec::new();
    for mut room in ctx.db.room().iter() {
        if let Some(last_seen) = room.last_host_seen {
            if last_seen + TimeDuration::from_micros(HOST_STALE_MICROS) < now {
                stale_rooms.push(room.code);
            }
        } else {
            // Give rooms created before heartbeat support one grace window to reconnect.
            room.last_host_seen = Some(now);
            ctx.db.room().code().update(room);
        }
    }
    for code in stale_rooms {
        delete_room_data(ctx, &code);
    }
}

#[spacetimedb::reducer]
pub fn start_game(
    ctx: &ReducerContext,
    room_code: String,
    shuffle_seed: String,
) -> Result<(), String> {
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
    if ctx
        .db
        .player()
        .room_code()
        .filter(&room_code)
        .next()
        .is_none()
    {
        return Err("At least one player must join before starting".into());
    }
    set_round_song(ctx, &room_code, room.current_round, &shuffle_seed)?;
    ctx.db.room().code().update(Room {
        status: STATUS_PLAYING.to_string(),
        ..room
    });
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
    ctx.db.room().code().update(Room {
        status: STATUS_PAUSED.to_string(),
        ..room
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn vote_skip(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    if room.status != STATUS_PLAYING && room.status != STATUS_PAUSED {
        return Err("The current song cannot be skipped".into());
    }

    let player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "Join this room before voting to skip".to_string())?;
    if player.room_code != room_code {
        return Err("You are not a member of this room".into());
    }
    if ctx
        .db
        .skip_vote()
        .identity()
        .find(ctx.sender())
        .is_some_and(|vote| vote.room_code == room_code && vote.round == room.current_round)
    {
        return Err("You have already voted to skip this song".into());
    }

    let vote = SkipVote {
        identity: ctx.sender(),
        room_code: room_code.clone(),
        round: room.current_round,
    };
    if ctx.db.skip_vote().identity().find(ctx.sender()).is_some() {
        ctx.db.skip_vote().identity().update(vote);
    } else {
        ctx.db.skip_vote().insert(vote);
    }

    let player_count = ctx.db.player().room_code().filter(&room_code).count();
    let skip_vote_count = ctx
        .db
        .skip_vote()
        .room_code()
        .filter(&room_code)
        .filter(|vote| vote.round == room.current_round)
        .count();
    if skip_vote_count == player_count {
        let mut state = ctx
            .db
            .round_state()
            .room_code()
            .find(room_code.clone())
            .ok_or_else(|| "Round state not found".to_string())?;
        let secret = ctx
            .db
            .song_secret()
            .room_code()
            .filter(&room_code)
            .next()
            .ok_or_else(|| "Song secret not found".to_string())?;
        state.revealed_track_name = Some(secret.track_name);
        state.revealed_artist_name = Some(secret.artist_name);
        state.locked_by = None;
        state.locked_by_name = None;
        state.buzz_timestamp = None;
        ctx.db.round_state().room_code().update(state);
        ctx.db.room().code().update(Room {
            status: STATUS_ROUND_OVER.to_string(),
            ..room
        });
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn submit_guess(
    ctx: &ReducerContext,
    room_code: String,
    guessed_track_id: i64,
) -> Result<(), String> {
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
    let started_at = state
        .buzz_timestamp
        .ok_or_else(|| "Guess timer is missing".to_string())?;
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
    if player.room_code != room_code {
        return Err("You are not a member of this room".into());
    }
    let secret = ctx
        .db
        .song_secret()
        .room_code()
        .filter(&room_code)
        .next()
        .ok_or_else(|| "Song secret not found".to_string())?;

    if guessed_track_id == secret.track_id {
        let mut player = player;
        let score = adjust_score(&mut player, 1)?;
        let correct_streak = player.correct_streak + 1;
        let player_name = player.name.clone();
        player.correct_streak = correct_streak;
        ctx.db.player().identity().update(player);
        ctx.db.round_state().room_code().update(RoundState {
            revealed_track_name: Some(secret.track_name),
            revealed_artist_name: Some(secret.artist_name),
            ..state
        });
        if score >= i64::from(room.target_score) {
            ctx.db.room().code().update(Room {
                status: STATUS_GAME_OVER.to_string(),
                winner_name: Some(player_name),
                ..room
            });
        } else {
            ctx.db.room().code().update(Room {
                status: STATUS_ROUND_OVER.to_string(),
                ..room
            });
        }
    } else {
        let mut player = player;
        adjust_score(&mut player, -1)?;
        player.correct_streak = 0;
        player.locked_out_this_round = true;
        ctx.db.player().identity().update(player);
        let mut state = state;
        state.locked_by = None;
        state.locked_by_name = None;
        state.buzz_timestamp = None;
        ctx.db.round_state().room_code().update(state);
        ctx.db.room().code().update(Room {
            status: STATUS_PLAYING.to_string(),
            ..room
        });
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
    if state.locked_by != Some(ctx.sender()) {
        return Err("Only the player with the buzzer can end the guess timer".into());
    }
    let started_at = state
        .buzz_timestamp
        .ok_or_else(|| "Guess timer is missing".to_string())?;
    if ctx.timestamp < started_at + TimeDuration::from_micros(GUESS_WINDOW_MICROS) {
        return Err("The ten-second guess window has not expired".into());
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
    ctx.db.room().code().update(Room {
        status: STATUS_ROUND_OVER.to_string(),
        ..room
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn next_round(
    ctx: &ReducerContext,
    room_code: String,
    shuffle_seed: String,
) -> Result<(), String> {
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
    set_round_song(ctx, &room_code, next, &shuffle_seed)?;
    for player in ctx.db.player().room_code().filter(&room_code) {
        if player.locked_out_this_round {
            ctx.db.player().identity().update(Player {
                locked_out_this_round: false,
                ..player
            });
        }
    }
    ctx.db.room().code().update(Room {
        status: STATUS_PLAYING.to_string(),
        current_round: next,
        ..room
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn end_game(ctx: &ReducerContext, room_code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(room_code.clone())
        .ok_or_else(|| "Room not found".to_string())?;
    require_host(ctx, &room)?;
    if room.status == STATUS_GAME_OVER {
        return Err("The game has already ended".into());
    }

    let mut players: Vec<(i64, Player)> = ctx
        .db
        .player()
        .room_code()
        .filter(&room_code)
        .map(|player| (effective_score(&player), player))
        .collect();
    players.sort_by(|(a_score, a), (b_score, b)| {
        b_score.cmp(a_score).then_with(|| a.name.cmp(&b.name))
    });
    let winner_name = players.first().and_then(|(leader_score, leader)| {
        let has_unique_lead = players
            .get(1)
            .is_none_or(|(runner_up_score, _)| runner_up_score < leader_score);
        (*leader_score > 0 && has_unique_lead).then(|| leader.name.clone())
    });

    ctx.db.room().code().update(Room {
        status: STATUS_GAME_OVER.to_string(),
        winner_name,
        ..room
    });
    Ok(())
}
