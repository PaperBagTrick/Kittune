import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import SongSearchModal from '../components/SongSearchModal';
import GuessResultOverlay from '../components/GuessResultOverlay';

type Props = { onBack: () => void };

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function newShuffleSeed() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function HostView({ onBack }: Props) {
  const [rooms] = useTable(tables.myRoom);
  const [allPlayers] = useTable(tables.playersInMyRoom);
  const [allSkipVotes] = useTable(tables.skipVotesForMyRoom);
  const [rounds] = useTable(tables.roundStateForMyRoom);
  const [hostAudioRows] = useTable(tables.hostRoundAudio);
  const [songCatalogs] = useTable(tables.availableSongCatalogs);
  const { identity, isActive, connectionError } = useSpacetimeDB();
  const createRoom = useReducer(reducers.createRoomWithCatalog);
  const hostHeartbeat = useReducer(reducers.hostHeartbeat);
  const startGame = useReducer(reducers.startGame);
  const nextRound = useReducer(reducers.nextRound);
  const songEnded = useReducer(reducers.songEnded);
  const buzzIn = useReducer(reducers.buzzIn);
  const submitGuess = useReducer(reducers.submitGuess);
  const guessTimeout = useReducer(reducers.guessTimeout);
  const voteSkip = useReducer(reducers.voteSkip);
  const quitRoom = useReducer(reducers.quitRoom);
  const [roomCode, setRoomCode] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [targetScoreInput, setTargetScoreInput] = useState('3');
  const [roomVisibility, setRoomVisibility] = useState<'PRIVATE' | 'PUBLIC'>('PRIVATE');
  const [catalogId, setCatalogId] = useState('top-1000');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(15);
  const [votingToSkip, setVotingToSkip] = useState(false);
  const [submittedSkipVote, setSubmittedSkipVote] = useState('');
  const [roomLoadTimedOut, setRoomLoadTimedOut] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timeoutSent = useRef(false);

  const room = rooms.find((row) => row.code === roomCode);
  const selectedCatalog = songCatalogs.find((catalog) => catalog.catalogId === catalogId);
  const roundState = rounds.find((row) => row.roomCode === roomCode);
  const hostAudio = hostAudioRows.find((row) => row.roomCode === roomCode);
  const identityHex = identity?.toHexString();
  const hostPlayer = allPlayers.find((player) => player.identity.toHexString() === identityHex);
  const isMyTurn = Boolean(
    room?.status === 'PAUSED_FOR_GUESS'
    && roundState?.lockedBy
    && identityHex
    && roundState.lockedBy.toHexString() === identityHex,
  );
  const players = useMemo(
    () => allPlayers.filter((player) => player.roomCode === roomCode)
      .sort((a, b) => (a.score === b.score ? a.name.localeCompare(b.name) : a.score > b.score ? -1 : 1)),
    [allPlayers, roomCode],
  );
  const onlinePlayers = useMemo(() => players.filter((player) => player.online && !player.eliminated), [players]);
  const onlinePlayerIdentities = useMemo(
    () => new Set(onlinePlayers.map((player) => player.identity.toHexString())),
    [onlinePlayers],
  );
  const roundSkipVotes = useMemo(
    () => allSkipVotes.filter((vote) =>
      vote.roomCode === roomCode
      && vote.round === room?.currentRound
      && onlinePlayerIdentities.has(vote.identity.toHexString())),
    [allSkipVotes, roomCode, room?.currentRound, onlinePlayerIdentities],
  );
  const skipVoteKey = `${roomCode}:${room?.currentRound ?? ''}`;
  const hasServerSkipVote = roundSkipVotes.some((vote) => vote.identity.toHexString() === identityHex);
  const hasVotedToSkip = hasServerSkipVote || submittedSkipVote === skipVoteKey;
  const displayedSkipVotes = roundSkipVotes.length + Number(!hasServerSkipVote && submittedSkipVote === skipVoteKey);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !room || !roundState || !hostAudio) return;
    if (room.status === 'PLAYING') {
      void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    } else {
      audio.pause();
    }
  }, [room?.status, hostAudio?.audioUrl, room, roundState, hostAudio]);

  useEffect(() => {
    if (room?.status !== 'ROUND_OVER' || !roomCode) return;
    const timer = window.setTimeout(() => {
      void nextRound({ roomCode, shuffleSeed: newShuffleSeed() }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Could not start the next track.');
      });
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [room?.status, roomCode, nextRound]);

  useEffect(() => {
    if (!isMyTurn || !roomCode) {
      timeoutSent.current = false;
      return;
    }
    const deadline = Date.now() + 15_000;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0 && !timeoutSent.current) {
        timeoutSent.current = true;
        void guessTimeout({ roomCode }).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'The guess timer could not finish.');
        });
      }
    };
    timeoutSent.current = false;
    setSecondsLeft(15);
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [isMyTurn, roomCode, guessTimeout]);

  async function create() {
    if (!isActive) {
      setError('Not connected to the game server yet. Please wait and try again.');
      return;
    }
    const name = nameInput.trim();
    if (!name) {
      setError('Add your display name before creating the room.');
      return;
    }
    const targetScore = Number(targetScoreInput);
    if (!Number.isInteger(targetScore) || targetScore < 1 || targetScore > 100) {
      setError('Points to win must be a whole number from 1 to 100.');
      return;
    }
    setBusy(true);
    setError('');
    const code = newRoomCode();
    try {
      await createRoom({ code, targetScore, hostName: name, visibility: roomVisibility, maxPlayers: 8, catalogId });
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
      await startGame({ roomCode, shuffleSeed: newShuffleSeed() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the game.');
    }
  }

  async function paw() {
    if (!roomCode) return;
    setError('');
    try {
      await buzzIn({ roomCode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not buzz in.');
    }
  }

  async function guess(trackId: number) {
    if (!roomCode) return;
    try {
      await submitGuess({ roomCode, guessedTrackId: BigInt(trackId) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit that guess.');
    }
  }

  async function skipSong() {
    if (!roomCode || hasVotedToSkip || votingToSkip) return;
    setError('');
    setVotingToSkip(true);
    try {
      await voteSkip({ roomCode });
      setSubmittedSkipVote(skipVoteKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not vote to skip this song.');
    } finally {
      setVotingToSkip(false);
    }
  }

  async function quit() {
    setError('');
    if (!roomCode) {
      onBack();
      return;
    }
    try {
      await quitRoom();
      onBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not leave the room.');
    }
  }

  const isHost = Boolean(room && identity && room.hostIdentity.toHexString() === identity.toHexString());

  useEffect(() => {
    setRoomLoadTimedOut(false);
    if (!roomCode || (room && isHost)) return;
    const timer = window.setTimeout(() => setRoomLoadTimedOut(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [roomCode, Boolean(room), isHost]);

  useEffect(() => {
    if (!roomCode || !isHost) return;
    const heartbeat = () => {
      void hostHeartbeat({ roomCode }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Could not keep the room active.');
      });
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 60_000);
    return () => window.clearInterval(timer);
  }, [roomCode, isHost, hostHeartbeat]);

  return (
    <main className="host-shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => roomCode ? void quit() : onBack()} aria-label="Back to home"><span>🐾</span> KITTUNE</button>
        <div className="topbar-right"><span className="live-pill"><i /> LIVE ROOM</span><span className="topbar-caption">HOST DISPLAY</span>{roomCode && <button className="button button-secondary quit-room-button" onClick={() => void quit()}>Quit room</button>}</div>
      </header>

      {!roomCode ? (
        <section className="host-setup panel">
          <span className="panel-kicker">YOUR ROOM, YOUR RULES</span>
          <h1>Ready to make<br /><em>some noise?</em></h1>
          <p>Join the game from this screen, then put it somewhere everyone can see and let the paws fly.</p>
          <label className="form-label host-name-field">YOUR DISPLAY NAME<input value={nameInput} onChange={(event) => setNameInput(event.target.value.slice(0, 24))} placeholder="e.g. DJ Whiskers" maxLength={24} autoComplete="nickname" /></label>
          <label className="form-label host-name-field">POINTS TO WIN<input type="number" min={1} max={100} step={1} value={targetScoreInput} onChange={(event) => setTargetScoreInput(event.target.value)} inputMode="numeric" /></label>
          <label className="form-label host-name-field">ROOM VISIBILITY<select value={roomVisibility} onChange={(event) => setRoomVisibility(event.target.value as 'PRIVATE' | 'PUBLIC')}><option value="PRIVATE">Private — join by code</option><option value="PUBLIC">Public — listed for everyone</option></select></label>
          <label className="form-label host-name-field">SONG LIST<select value={catalogId} onChange={(event) => setCatalogId(event.target.value)}>{songCatalogs.map((catalog) => <option key={catalog.catalogId} value={catalog.catalogId}>{catalog.name}</option>)}</select></label>
          {selectedCatalog && <p className="muted-note">{selectedCatalog.description} {selectedCatalog.qualityNote}</p>}
          <button className="button button-primary button-large" onClick={() => void create()} disabled={busy || !isActive}>
            {busy ? 'Opening room…' : isActive ? 'Create Kittune Room' : 'Connecting…'} <span>🐾</span>
          </button>
          {!isActive && <p className="muted-note">{connectionError ? 'Could not connect to the game server.' : 'Connecting to the game server…'}</p>}
          {error && <p className="error-note">{error}</p>}
        </section>
      ) : !room || !isHost ? (
        <section className="panel waiting-panel">
          {roomLoadTimedOut ? (
            <>
              <h2>Couldn’t connect to room {roomCode}</h2>
              <p>The server did not return the room data this screen needs. Its module may be out of date with this client. Ask the database owner to publish the latest server module without deleting data, then try again.</p>
              <button className="button button-secondary" onClick={() => { setRoomCode(''); setError(''); }}>Back to room setup</button>
            </>
          ) : (
            <><span className="spinner" /> Connecting to room {roomCode}…</>
          )}
        </section>
      ) : room.status === 'LOBBY' ? (
        <section className="lobby-layout">
          <div className="lobby-main panel">
            <div className="panel-heading"><span className="panel-kicker">{room.visibility === 'PUBLIC' ? 'PUBLIC ROOM' : 'PRIVATE ROOM'} · ROOM CODE</span><span className="host-status">WAITING FOR PLAYERS</span></div>
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
            <div className="panel-heading"><div><span className="panel-kicker">THE CREW</span><h2>Players <b>{players.length}</b></h2></div><span className="people-count">{players.length} / {room.maxPlayers}</span></div>
            <div className="player-list">
              {players.map((player, index) => (
                <div className={`player-card ${player.eliminated ? 'is-eliminated' : ''}`} key={player.identity.toHexString()}>
                  <span className={`avatar avatar-${index % 5}`}>{['🐱', '🐈', '😼', '🐾', '😺'][index % 5]}</span>
                  <span className="player-name"><span className={`presence-indicator ${player.online ? 'is-online' : 'is-offline'}`} role="img" aria-label={player.online ? 'Online' : 'Offline'} title={player.online ? 'Online' : 'Offline'} /><span className="player-label">{player.name}</span>{player.correctStreak >= 3 && <span className="streak-fire" title={`${player.correctStreak} correct guesses in a row`}>🔥</span>}</span>
                  <span className="score-chip">{player.score.toString()}<small> pts</small>{player.eliminated && <small className="eliminated-badge">OUT</small>}</span>
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
              <div className="winner-screen panel">{room.winnerName && <div className="confetti">✦ ✧ ✨ ✦</div>}<span className="winner-paw">{room.winnerName ? '🏆' : '🐾'}</span><p className="panel-kicker">{room.winnerName ? 'THE TOP CAT' : 'GAME OVER'}</p><h1>{room.winnerName ? <>{room.winnerName} <em>wins!</em></> : <>Everyone’s <em>out.</em></>}</h1><p>{room.winnerName ? 'What a game. The crown stays with the cat.' : 'No players remain in the game.'}</p>{roundState?.revealedTrackName && <div className="final-track-reveal"><img src={roundState.artworkUrl} alt="Album artwork" /><span><b>{roundState.revealedTrackName}</b><small>{roundState.revealedArtistName}</small></span></div>}</div>
            ) : room.status === 'PAUSED_FOR_GUESS' ? (
              <div className="buzz-banner panel"><div className="buzz-ripple">🐾</div><p className="panel-kicker">{isMyTurn ? 'YOU GOT THE BUZZER' : 'THE BUZZER HAS SPOKEN'}</p><h1>{isMyTurn ? <>Quick! Name<br /><em>that tune!</em></> : <>{roundState?.lockedByName ?? 'A player'}<br /><em>PAWED THE BUZZER!</em></>}</h1><p>{isMyTurn ? 'Choose a track before the timer runs out.' : 'Can they name that tune?'}</p></div>
            ) : room.status === 'ROUND_OVER' ? (
              <div className="reveal-card panel">
                <img className="reveal-art" src={roundState?.artworkUrl} alt="Album artwork" />
                <div className="reveal-copy"><span className="panel-kicker">THAT WAS THE TRACK</span><h1>{roundState?.revealedTrackName ?? 'Track revealed'}</h1><p>{roundState?.revealedArtistName}</p><p className="muted-note">Next track starting soon…</p></div>
              </div>
            ) : (
              <div className="playing-card panel">
                <div className="playing-copy"><span className="sound-bars"><i /><i /><i /><i /><i /><i /></span><span className="panel-kicker">LISTEN CLOSELY</span><h1>What’s<br /><em>that sound?</em></h1><p>The first paw to the buzzer gets fifteen seconds to name the track.</p><div className="audio-indicator"><i /> AUDIO IS LIVE</div></div>
                <button className="paw-button host-paw-button" onClick={() => void paw()} disabled={!hostPlayer || hostPlayer.lockedOutThisRound || hostPlayer.eliminated} aria-label="Paw the buzzer"><span>🐾</span><b>{hostPlayer?.eliminated ? 'OUT' : hostPlayer?.lockedOutThisRound ? 'SCRATCHED' : 'PAW IN'}</b></button>
                {audioBlocked && <button className="audio-enable" onClick={() => { void audioRef.current?.play().then(() => setAudioBlocked(false)); }}>Tap to enable audio</button>}
              </div>
            )}
            {(room.status === 'PLAYING' || room.status === 'PAUSED_FOR_GUESS') && (
              <div className="skip-vote-panel panel">
                <span><b>{displayedSkipVotes} / {onlinePlayers.length}</b> votes to skip</span>
                <button className="button button-secondary" onClick={() => void skipSong()} disabled={hasVotedToSkip || votingToSkip || Boolean(hostPlayer?.eliminated)}>
                  {hostPlayer?.eliminated ? 'Eliminated' : hasVotedToSkip ? 'Vote recorded' : votingToSkip ? 'Voting…' : 'Vote to skip'}
                </button>
              </div>
            )}
          </div>
          <aside className="scoreboard panel">
            <div className="panel-heading"><div><span className="panel-kicker">THE LEADERBOARD</span><h2>Scoreboard</h2></div><span className="score-trophy">🏆</span></div>
            <div className="score-list">
              {players.map((player, index) => <div key={player.identity.toHexString()} className={`score-row ${index === 0 && player.score > 0n ? 'score-leader' : ''} ${player.eliminated ? 'is-eliminated' : ''}`}><span className="rank">{String(index + 1).padStart(2, '0')}</span><span className={`avatar avatar-${index % 5}`}>{['🐱', '🐈', '😼', '🐾', '😺'][index % 5]}</span><span className="player-name"><span className={`presence-indicator ${player.online ? 'is-online' : 'is-offline'}`} role="img" aria-label={player.online ? 'Online' : 'Offline'} title={player.online ? 'Online' : 'Offline'} /><span className="player-label">{player.name}</span>{player.eliminated && <small className="eliminated-badge">OUT</small>}{player.correctStreak >= 3 && <span className="streak-fire" title={`${player.correctStreak} correct guesses in a row`}>🔥</span>}</span><span className="score-number">{player.score.toString()}</span></div>)}
              {players.length === 0 && <p className="muted-note">No players yet.</p>}
            </div>
            <div className="target-progress"><span>FIRST TO {room.targetScore}</span><div className="target-dots">{Array.from({ length: room.targetScore }, (_, i) => <i key={i} className={players.some((p) => p.score > BigInt(i)) ? 'filled' : ''} />)}</div></div>
          </aside>
        </section>
      )}

      <footer className="host-footer"><span>ROOM <b>{roomCode || '— — — —'}</b></span><span>🎧 &nbsp; Turn it up. Keep it kind.</span><span>KITTUNE <b>✦</b></span></footer>
      {roomCode && roundState && hostAudio && <audio ref={audioRef} src={hostAudio.audioUrl} onEnded={() => { void songEnded({ roomCode }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The preview could not finish the round.')); }} />}
      {isMyTurn && <SongSearchModal secondsLeft={secondsLeft} onSelect={guess} preferredTrackId={roundState?.guessTargetTrackId} />}
      {roomCode && <GuessResultOverlay roomCode={roomCode} round={room?.currentRound ?? -1} result={roundState?.lastGuessResult} playerName={roundState?.lastGuessPlayerName} sequence={roundState?.guessResultSequence ?? 0} />}
      {error && <div className="toast-error" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
    </main>
  );
}
