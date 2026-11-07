import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';

type Props = { onBack: () => void };

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export default function HostView({ onBack }: Props) {
  const [rooms] = useTable(tables.room);
  const [allPlayers] = useTable(tables.player);
  const [rounds] = useTable(tables.roundState);
  const { identity } = useSpacetimeDB();
  const createRoom = useReducer(reducers.createRoom);
  const startGame = useReducer(reducers.startGame);
  const nextRound = useReducer(reducers.nextRound);
  const songEnded = useReducer(reducers.songEnded);
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const room = rooms.find((row) => row.code === roomCode);
  const roundState = rounds.find((row) => row.roomCode === roomCode);
  const players = useMemo(
    () => allPlayers.filter((player) => player.roomCode === roomCode)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    [allPlayers, roomCode],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !room || !roundState) return;
    if (room.status === 'PLAYING') {
      void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    } else {
      audio.pause();
    }
  }, [room?.status, roundState?.audioUrl, room, roundState]);

  async function create() {
    setBusy(true);
    setError('');
    const code = newRoomCode();
    try {
      await createRoom({ code, targetScore: 5 });
      setRoomCode(code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the room. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!roomCode) return;
    setError('');
    try {
      await startGame({ roomCode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the game.');
    }
  }

  async function advance() {
    if (!roomCode) return;
    setError('');
    try {
      await nextRound({ roomCode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the next track.');
    }
  }

  const isHost = Boolean(room && identity && room.hostIdentity.toHexString() === identity.toHexString());

  return (
    <main className="host-shell">
      <header className="topbar">
        <button className="wordmark" onClick={onBack} aria-label="Back to home"><span>🐾</span> KITTUNE</button>
        <div className="topbar-right"><span className="live-pill"><i /> LIVE ROOM</span><span className="topbar-caption">HOST DISPLAY</span></div>
      </header>

      {!roomCode ? (
        <section className="host-setup panel">
          <span className="panel-kicker">YOUR ROOM, YOUR RULES</span>
          <h1>Ready to make<br /><em>some noise?</em></h1>
          <p>Create a room code, put this screen somewhere everyone can see, and let the paws fly.</p>
          <button className="button button-primary button-large" onClick={() => void create()} disabled={busy}>
            {busy ? 'Opening room…' : 'Create Kittune Room'} <span>🐾</span>
          </button>
          {error && <p className="error-note">{error}</p>}
        </section>
      ) : !room || !isHost ? (
        <section className="panel waiting-panel"><span className="spinner" /> Connecting to room {roomCode}…</section>
      ) : room.status === 'LOBBY' ? (
        <section className="lobby-layout">
          <div className="lobby-main panel">
            <div className="panel-heading"><span className="panel-kicker">ROOM CODE</span><span className="host-status">WAITING FOR PLAYERS</span></div>
            <div className="room-code" aria-label={`Room code ${room.code}`}>{room.code.split('').map((letter, i) => <span key={i}>{letter}</span>)}</div>
            <p className="lobby-instruction">Join at <strong>kittune.game</strong> or scan to play</p>
            <div className="qr-placeholder" aria-label="QR code placeholder">
              <span className="qr-cat">🐈</span><span className="qr-label">SCAN TO JOIN</span>
            </div>
            <div className="lobby-actions">
              <button className="button button-secondary" onClick={() => void navigator.clipboard?.writeText(`${location.origin}/?join=${room.code}`)}>Copy invite link</button>
              <button className="button button-primary" onClick={() => void start()} disabled={players.length === 0}>Start Kittune <span>→</span></button>
            </div>
            {players.length === 0 && <p className="muted-note">Waiting for the first player to join…</p>}
            {error && <p className="error-note">{error}</p>}
          </div>
          <aside className="players-panel panel">
            <div className="panel-heading"><div><span className="panel-kicker">THE CREW</span><h2>Players <b>{players.length}</b></h2></div><span className="people-count">{players.length} / 12</span></div>
            <div className="player-list">
              {players.map((player, index) => (
                <div className="player-card" key={player.identity.toHexString()}>
                  <span className={`avatar avatar-${index % 5}`}>{['🐱', '🐈', '😼', '🐾', '😺'][index % 5]}</span>
                  <span className="player-name">{player.name}</span>
                  <span className="score-chip">{player.score}<small> pts</small></span>
                </div>
              ))}
              {players.length === 0 && <div className="empty-crew"><span>🐾</span><p>Your crew will show up here</p></div>}
            </div>
            <p className="target-note">First to <b>{room.targetScore}</b> points wins</p>
          </aside>
        </section>
      ) : (
        <section className="game-layout">
          <div className="game-main">
            <div className="game-meta"><span className="panel-kicker">ROUND {room.currentRound + 1}</span><span className="game-status">{room.status.replaceAll('_', ' ')}</span></div>
            {room.status === 'GAME_OVER' ? (
              <div className="winner-screen panel"><div className="confetti">✦ ✧ ✨ ✦</div><span className="winner-paw">🏆</span><p className="panel-kicker">THE TOP CAT</p><h1>{room.winnerName} <em>wins!</em></h1><p>What a game. The crown stays with the cat.</p></div>
            ) : room.status === 'PAUSED_FOR_GUESS' ? (
              <div className="buzz-banner panel"><div className="buzz-ripple">🐾</div><p className="panel-kicker">THE BUZZER HAS SPOKEN</p><h1>{roundState?.lockedByName ?? 'A player'}<br /><em>PAWED THE BUZZER!</em></h1><p>Can they name that tune?</p></div>
            ) : room.status === 'ROUND_OVER' ? (
              <div className="reveal-card panel">
                <img className="reveal-art" src={roundState?.artworkUrl} alt="Album artwork" />
                <div className="reveal-copy"><span className="panel-kicker">THAT WAS THE TRACK</span><h1>{roundState?.revealedTrackName ?? 'Track revealed'}</h1><p>{roundState?.revealedArtistName}</p><button className="button button-primary" onClick={() => void advance()}>Next track <span>→</span></button></div>
              </div>
            ) : (
              <div className="playing-card panel">
                <div className="playing-copy"><span className="sound-bars"><i /><i /><i /><i /><i /><i /></span><span className="panel-kicker">LISTEN CLOSELY</span><h1>What’s<br /><em>that sound?</em></h1><p>The first paw to the buzzer gets five seconds to name the track.</p><div className="audio-indicator"><i /> AUDIO IS LIVE</div></div>
                <div className="art-blur" style={{ backgroundImage: roundState?.artworkUrl ? `url(${roundState.artworkUrl})` : undefined }}><div className="art-placeholder">🎵</div></div>
                {audioBlocked && <button className="audio-enable" onClick={() => { void audioRef.current?.play().then(() => setAudioBlocked(false)); }}>Tap to enable audio</button>}
              </div>
            )}
          </div>
          <aside className="scoreboard panel">
            <div className="panel-heading"><div><span className="panel-kicker">THE LEADERBOARD</span><h2>Scoreboard</h2></div><span className="score-trophy">🏆</span></div>
            <div className="score-list">
              {players.map((player, index) => <div key={player.identity.toHexString()} className={`score-row ${index === 0 && player.score > 0 ? 'score-leader' : ''}`}><span className="rank">{String(index + 1).padStart(2, '0')}</span><span className={`avatar avatar-${index % 5}`}>{['🐱', '🐈', '😼', '🐾', '😺'][index % 5]}</span><span className="player-name">{player.name}</span><span className="score-number">{player.score}</span></div>)}
              {players.length === 0 && <p className="muted-note">No players yet.</p>}
            </div>
            <div className="target-progress"><span>FIRST TO {room.targetScore}</span><div className="target-dots">{Array.from({ length: room.targetScore }, (_, i) => <i key={i} className={players.some((p) => p.score > i) ? 'filled' : ''} />)}</div></div>
          </aside>
        </section>
      )}

      <footer className="host-footer"><span>ROOM <b>{roomCode || '— — — —'}</b></span><span>🎧 &nbsp; Turn it up. Keep it kind.</span><span>KITTUNE <b>✦</b></span></footer>
      {roomCode && roundState && <audio ref={audioRef} src={roundState.audioUrl} onEnded={() => void songEnded({ roomCode })} />}
    </main>
  );
}
