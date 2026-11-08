import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import SongSearchModal from '../components/SongSearchModal';

type Props = { onBack: () => void };

export default function PlayerView({ onBack }: Props) {
  const [rooms] = useTable(tables.myRoom);
  const [players] = useTable(tables.playersInMyRoom);
  const [publicLobbies] = useTable(tables.publicLobbies);
  const [skipVotes] = useTable(tables.skipVotesForMyRoom);
  const [rounds] = useTable(tables.roundStateForMyRoom);
  const [roundAudioRows] = useTable(tables.playerRoundAudio);
  const { identity, isActive, connectionError } = useSpacetimeDB();
  const joinRoom = useReducer(reducers.joinRoom);
  const joinPublicRoom = useReducer(reducers.joinPublicRoom);
  const buzzIn = useReducer(reducers.buzzIn);
  const submitGuess = useReducer(reducers.submitGuess);
  const guessTimeout = useReducer(reducers.guessTimeout);
  const voteSkip = useReducer(reducers.voteSkip);
  const [roomCodeInput, setRoomCodeInput] = useState(() => new URLSearchParams(location.search).get('join')?.toUpperCase().slice(0, 4) ?? '');
  const [nameInput, setNameInput] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(10);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [votingToSkip, setVotingToSkip] = useState(false);
  const [submittedSkipVote, setSubmittedSkipVote] = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timeoutSent = useRef(false);

  const room = rooms.find((row) => row.code === roomCode);
  const roundState = rounds.find((row) => row.roomCode === roomCode);
  const roundAudio = roundAudioRows.find((row) => row.roomCode === roomCode);
  const identityHex = identity?.toHexString();
  const myPlayer = players.find((player) => player.identity.toHexString() === identityHex);
  const isMyTurn = Boolean(room?.status === 'PAUSED_FOR_GUESS' && roundState?.lockedBy && identityHex && roundState.lockedBy.toHexString() === identityHex);
  const otherPlayer = players.find((player) => player.identity.toHexString() === roundState?.lockedBy?.toHexString());

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !room || !roundAudio) return;
    if (room.status === 'PLAYING') {
      void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    } else {
      audio.pause();
    }
  }, [room?.status, roundAudio?.audioUrl, room, roundAudio]);

  useEffect(() => {
    if (myPlayer && !roomCode) {
      setRoomCode(myPlayer.roomCode);
      setNameInput(myPlayer.name);
    }
  }, [myPlayer, roomCode]);

  useEffect(() => {
    if (!isMyTurn || !roomCode) {
      timeoutSent.current = false;
      return;
    }
    const deadline = Date.now() + 10_000;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0 && !timeoutSent.current) {
        timeoutSent.current = true;
        void guessTimeout({ roomCode }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The guess timer could not finish.'));
      }
    };
    timeoutSent.current = false;
    setSecondsLeft(10);
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [isMyTurn, roomCode, guessTimeout]);

  const buzzKey = `${roomCode}:${roundState?.lockedBy?.toHexString() ?? ''}:${roundState?.buzzTimestamp?.toString() ?? ''}`;
  const lastBuzz = useRef('');
  useEffect(() => {
    if (isMyTurn && buzzKey !== lastBuzz.current) {
      lastBuzz.current = buzzKey;
      navigator.vibrate?.([100, 50, 100]);
    }
  }, [isMyTurn, buzzKey]);

  const sortedPlayers = useMemo(
    () => players.filter((player) => player.roomCode === roomCode)
      .sort((a, b) => (a.score === b.score ? a.name.localeCompare(b.name) : a.score > b.score ? -1 : 1)),
    [players, roomCode],
  );
  const roundSkipVotes = useMemo(
    () => skipVotes.filter((vote) => vote.roomCode === roomCode && vote.round === room?.currentRound),
    [skipVotes, roomCode, room?.currentRound],
  );
  const skipVoteKey = `${roomCode}:${room?.currentRound ?? ''}`;
  const hasServerSkipVote = roundSkipVotes.some((vote) => vote.identity.toHexString() === identityHex);
  const hasVotedToSkip = hasServerSkipVote || submittedSkipVote === skipVoteKey;
  const displayedSkipVotes = roundSkipVotes.length + Number(!hasServerSkipVote && submittedSkipVote === skipVoteKey);

  async function joinWithCode(code: string, name: string, isPublic: boolean) {
    setBusy(true);
    setError('');
    let timeoutId: number | undefined;
    try {
      await Promise.race([
        isPublic ? joinPublicRoom({ code, name }) : joinRoom({ code, name }),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error('Joining timed out. Check the room code and server connection, then try again.')),
            15_000,
          );
        }),
      ]);
      setRoomCode(code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join that room. Check the code.');
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      setBusy(false);
    }
  }

  async function join() {
    const code = roomCodeInput.trim().toUpperCase();
    const name = nameInput.trim();
    if (code.length !== 4) return setError('Room codes have four letters.');
    if (!name) return setError('Add your name to join the game.');
    await joinWithCode(code, name, false);
  }

  async function joinPublic(code: string) {
    const name = nameInput.trim();
    if (!name) return setError('Add your name before joining a public game.');
    await joinWithCode(code, name, true);
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

  if (!roomCode) {
    return (
      <main className="player-shell player-join-shell">
        <header className="topbar"><button className="wordmark" onClick={onBack}><span>🐾</span> KITTUNE</button><span className="join-tag">PLAYER PAW</span></header>
        <section className="join-card panel">
          <div className="join-mascot">🐈</div>
          <span className="panel-kicker">YOUR PHONE IS YOUR BUZZER</span>
          <h1>Let’s play,<br /><em>music cat.</em></h1>
          <p>Join a public game or use a private room code.</p>
          <label className="form-label">YOUR NAME<input value={nameInput} onChange={(event) => setNameInput(event.target.value.slice(0, 24))} placeholder="e.g. DJ Whiskers" maxLength={24} autoComplete="nickname" /></label>
          <label className="form-label private-code-field">PRIVATE ROOM CODE<input value={roomCodeInput} onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))} placeholder="ABCD" maxLength={4} autoComplete="off" /></label>
          <button className="button button-primary button-large join-button" disabled={busy || !isActive} onClick={() => void join()}>{busy ? 'Joining…' : isActive ? 'Join the game' : 'Connecting…'} <span>🐾</span></button>
          {!isActive && <p className="muted-note">{connectionError ? 'Could not connect to the game server.' : 'Connecting to the game server…'}</p>}
          {error && <p className="error-note">{error}</p>}
        </section>
        <section className="public-rooms panel">
          <div className="public-rooms-heading"><div><span className="panel-kicker">OPEN TO EVERYONE</span><h2>Public games</h2></div><span className="people-count">{publicLobbies.length} OPEN</span></div>
          {publicLobbies.length === 0 ? <p className="muted-note">No public rooms right now. Host one or join with a private code.</p> : (
            <div className="public-rooms-list">
              {publicLobbies.map((lobby) => (
                <article className="public-room-card" key={lobby.code}>
                  <div><b>Room {lobby.code}</b><span>{lobby.playerCount}/{lobby.maxPlayers} players · first to {lobby.targetScore}</span></div>
                  <button className="button button-secondary" disabled={busy || !isActive || !nameInput.trim()} onClick={() => void joinPublic(lobby.code)}>{busy ? 'Joining…' : 'Join'}</button>
                </article>
              ))}
            </div>
          )}
          <button className="text-button" onClick={onBack}>← Back to Kittune</button>
        </section>
      </main>
    );
  }

  if (!myPlayer) {
    return <main className="player-shell"><header className="player-topbar"><button className="wordmark" onClick={onBack}><span>🐾</span> KITTUNE</button></header><section className="player-center panel"><span className="spinner" /> Joining room {roomCode}…</section></main>;
  }

  return (
    <main className={`player-shell ${isMyTurn ? 'player-my-turn' : ''}`}>
      <header className="player-topbar"><button className="wordmark" onClick={onBack}><span>🐾</span> KITTUNE</button><span className="room-mini">ROOM <b>{roomCode}</b></span><span className="player-score-pill">{myPlayer.name}{myPlayer.correctStreak >= 3 && <span className="streak-fire" title={`${myPlayer.correctStreak} correct guesses in a row`}>🔥</span>} <b>{myPlayer.score.toString()} pts</b></span></header>
      {!room ? (
        <section className="player-center panel"><span className="spinner" /> Finding room {roomCode}…</section>
      ) : room.status === 'LOBBY' ? (
        <section className="player-center panel player-prompt"><span className="big-paw">⏳</span><span className="panel-kicker">YOU’RE IN</span><h1>Waiting for<br /><em>the game…</em></h1><p>Keep your paws ready, {myPlayer.name}.</p></section>
      ) : (
        <section className="game-layout player-game-layout">
          <div className="game-main">
            <div className="game-meta"><span className="panel-kicker">ROUND {room.currentRound + 1}</span><span className="game-status">{room.status.replaceAll('_', ' ')}</span></div>
            {room.status === 'GAME_OVER' ? (
              <div className="winner-screen panel"><div className="confetti">✦ ✧ ✨ ✦</div><span className="winner-paw">🏆</span><p className="panel-kicker">THE TOP CAT</p><h1>{room.winnerName} <em>wins!</em></h1><p>What a game. The crown stays with the cat.</p>{roundState?.revealedTrackName && <div className="final-track-reveal"><img src={roundState.artworkUrl} alt="Album artwork" /><span><b>{roundState.revealedTrackName}</b><small>{roundState.revealedArtistName}</small></span></div>}</div>
            ) : room.status === 'PAUSED_FOR_GUESS' ? (
              <div className="buzz-banner panel"><div className="buzz-ripple">🐾</div><p className="panel-kicker">{isMyTurn ? 'YOU GOT THE BUZZER' : 'THE BUZZER HAS SPOKEN'}</p><h1>{isMyTurn ? <>Quick! Name<br /><em>that tune!</em></> : <>{otherPlayer?.name ?? roundState?.lockedByName ?? 'A player'}<br /><em>PAWED THE BUZZER!</em></>}</h1><p>{isMyTurn ? 'Choose a track before the timer runs out.' : 'Can they name that tune?'}</p></div>
            ) : room.status === 'ROUND_OVER' ? (
              <div className="reveal-card panel">
                <img className="reveal-art" src={roundState?.artworkUrl} alt="Album artwork" />
                <div className="reveal-copy"><span className="panel-kicker">THAT WAS THE TRACK</span><h1>{roundState?.revealedTrackName ?? 'Track revealed'}</h1><p>{roundState?.revealedArtistName}</p><p className="muted-note">Next track starting soon…</p></div>
              </div>
            ) : (
              <div className="playing-card panel">
                <div className="playing-copy"><span className="sound-bars"><i /><i /><i /><i /><i /><i /></span><span className="panel-kicker">LISTEN CLOSELY</span><h1>What’s<br /><em>that sound?</em></h1><p>The first paw to the buzzer gets ten seconds to name the track.</p><div className="audio-indicator"><i /> AUDIO IS LIVE</div></div>
                <button className="paw-button host-paw-button" onClick={() => void paw()} disabled={myPlayer.lockedOutThisRound} aria-label="Paw the buzzer"><span>🐾</span><b>{myPlayer.lockedOutThisRound ? 'SCRATCHED' : 'PAW IN'}</b></button>
                {audioBlocked && <button className="audio-enable" onClick={() => { void audioRef.current?.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true)); }}>Tap to enable audio</button>}
              </div>
            )}
            {(room.status === 'PLAYING' || room.status === 'PAUSED_FOR_GUESS') && (
              <div className="skip-vote-panel panel">
                <span><b>{displayedSkipVotes} / {sortedPlayers.length}</b> votes to skip</span>
                <button className="button button-secondary" onClick={() => void skipSong()} disabled={hasVotedToSkip || votingToSkip}>
                  {hasVotedToSkip ? 'Vote recorded' : votingToSkip ? 'Voting…' : 'Vote to skip'}
                </button>
              </div>
            )}
          </div>
          <aside className="scoreboard panel">
            <div className="panel-heading"><div><span className="panel-kicker">THE LEADERBOARD</span><h2>Scoreboard</h2></div><span className="score-trophy">🏆</span></div>
            <div className="score-list">
              {sortedPlayers.map((player, index) => <div key={player.identity.toHexString()} className={`score-row ${index === 0 && player.score > 0n ? 'score-leader' : ''}`}><span className="rank">{String(index + 1).padStart(2, '0')}</span><span className={`avatar avatar-${index % 5}`}>{['🐱', '🐈', '😼', '🐾', '😺'][index % 5]}</span><span className="player-name"><span className="player-label">{player.name}</span>{player.correctStreak >= 3 && <span className="streak-fire" title={`${player.correctStreak} correct guesses in a row`}>🔥</span>}</span><span className="score-number">{player.score.toString()}</span></div>)}
              {sortedPlayers.length === 0 && <p className="muted-note">No players yet.</p>}
            </div>
            <div className="target-progress"><span>FIRST TO {room.targetScore}</span><div className="target-dots">{Array.from({ length: room.targetScore }, (_, index) => <i key={index} className={sortedPlayers.some((player) => player.score > BigInt(index)) ? 'filled' : ''} />)}</div></div>
          </aside>
        </section>
      )}
      <footer className="host-footer"><span>ROOM <b>{roomCode}</b></span><span>🎧 &nbsp; Turn it up. Keep it kind.</span><span>KITTUNE <b>✦</b></span></footer>
      {error && <div className="toast-error" role="status">{error}<button onClick={() => setError('')}>×</button></div>}
      {isMyTurn && <SongSearchModal secondsLeft={secondsLeft} onSelect={guess} />}
      {roomCode && roundState && roundAudio && <audio ref={audioRef} src={roundAudio.audioUrl} />}
    </main>
  );
}
