import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import SongSearchModal from '../components/SongSearchModal';

type Props = { onBack: () => void };

export default function PlayerView({ onBack }: Props) {
  const [rooms] = useTable(tables.room);
  const [players] = useTable(tables.player);
  const [rounds] = useTable(tables.roundState);
  const { identity, isActive } = useSpacetimeDB();
  const joinRoom = useReducer(reducers.joinRoom);
  const buzzIn = useReducer(reducers.buzzIn);
  const submitGuess = useReducer(reducers.submitGuess);
  const guessTimeout = useReducer(reducers.guessTimeout);
  const [roomCodeInput, setRoomCodeInput] = useState(() => new URLSearchParams(location.search).get('join')?.toUpperCase().slice(0, 4) ?? '');
  const [nameInput, setNameInput] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(5);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timeoutSent = useRef(false);

  const room = rooms.find((row) => row.code === roomCode);
  const roundState = rounds.find((row) => row.roomCode === roomCode);
  const identityHex = identity?.toHexString();
  const myPlayer = players.find((player) => player.identity.toHexString() === identityHex);
  const isMyTurn = Boolean(room?.status === 'PAUSED_FOR_GUESS' && roundState?.lockedBy && identityHex && roundState.lockedBy.toHexString() === identityHex);
  const otherPlayer = players.find((player) => player.identity.toHexString() === roundState?.lockedBy?.toHexString());

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
    const deadline = Date.now() + 5000;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0 && !timeoutSent.current) {
        timeoutSent.current = true;
        void guessTimeout({ roomCode }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The guess timer could not finish.'));
      }
    };
    timeoutSent.current = false;
    setSecondsLeft(5);
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
    () => players.filter((player) => player.roomCode === roomCode).sort((a, b) => b.score - a.score),
    [players, roomCode],
  );

  async function join() {
    const code = roomCodeInput.trim().toUpperCase();
    const name = nameInput.trim();
    if (code.length !== 4) return setError('Room codes have four letters.');
    if (!name) return setError('Add your name to join the game.');
    setBusy(true);
    setError('');
    try {
      await joinRoom({ code, name });
      setRoomCode(code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join that room. Check the code.');
    } finally {
      setBusy(false);
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

  if (!roomCode || !myPlayer) {
    return (
      <main className="player-shell player-join-shell">
        <header className="topbar"><button className="wordmark" onClick={onBack}><span>🐾</span> KITTUNE</button><span className="join-tag">PLAYER PAW</span></header>
        <section className="join-card panel">
          <div className="join-mascot">🐈</div>
          <span className="panel-kicker">YOUR PHONE IS YOUR BUZZER</span>
          <h1>Let’s play,<br /><em>music cat.</em></h1>
          <p>Enter your room code and pick the name your friends know.</p>
          <label className="form-label">ROOM CODE<input value={roomCodeInput} onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))} placeholder="ABCD" maxLength={4} autoComplete="off" /></label>
          <label className="form-label">YOUR NAME<input value={nameInput} onChange={(event) => setNameInput(event.target.value.slice(0, 24))} placeholder="e.g. DJ Whiskers" maxLength={24} autoComplete="nickname" /></label>
          <button className="button button-primary button-large join-button" disabled={busy || !isActive} onClick={() => void join()}>{busy ? 'Joining…' : isActive ? 'Join the game' : 'Connecting…'} <span>🐾</span></button>
          {error && <p className="error-note">{error}</p>}
          <button className="text-button" onClick={onBack}>← Back to Kittune</button>
        </section>
      </main>
    );
  }

  return (
    <main className={`player-shell ${isMyTurn ? 'player-my-turn' : ''}`}>
      <header className="player-topbar"><button className="wordmark" onClick={onBack}><span>🐾</span> KITTUNE</button><span className="room-mini">ROOM <b>{roomCode}</b></span><span className="player-score-pill">{myPlayer.name} <b>{myPlayer.score} pts</b></span></header>
      {!room ? <section className="player-center panel"><span className="spinner" /> Finding room {roomCode}…</section> : room.status === 'GAME_OVER' ? (
        <section className="player-center panel player-result"><span className="big-paw">🏆</span><span className="panel-kicker">GAME OVER</span><h1>{room.winnerName === myPlayer.name ? 'You’re the top cat!' : `${room.winnerName} takes the crown!`}</h1><p>Final score: {myPlayer.score} points</p></section>
      ) : room.status === 'ROUND_OVER' ? (
        <section className="player-center panel player-result"><span className="big-paw">🎵</span><span className="panel-kicker">TRACK REVEALED</span><h1>{roundState?.revealedTrackName}</h1><p>{roundState?.revealedArtistName}</p><p className="muted-note">Keep your paws ready for the next track.</p></section>
      ) : isMyTurn ? (
        <section className="player-center panel player-prompt"><span className="big-paw gold-paw">🐾</span><span className="panel-kicker">YOU GOT THE BUZZER</span><h1>Quick! Name<br /><em>that tune!</em></h1><p>Choose a track before the timer runs out.</p></section>
      ) : room.status === 'PAUSED_FOR_GUESS' ? (
        <section className="player-center panel player-prompt"><span className="big-paw">🐾</span><span className="panel-kicker">PAWS ON PAUSE</span><h1>{otherPlayer?.name ?? roundState?.lockedByName ?? 'Someone'}<br /><em>is guessing…</em></h1><p>Get ready. The song will resume if they miss.</p></section>
      ) : myPlayer.lockedOutThisRound ? (
        <section className="player-center panel player-prompt scratched"><span className="big-paw">😿</span><span className="panel-kicker">SCRATCHED</span><h1>Out for<br /><em>this track.</em></h1><p>You’ll be back in for the next round.</p></section>
      ) : room.status === 'LOBBY' ? (
        <section className="player-center panel player-prompt"><span className="big-paw">⏳</span><span className="panel-kicker">YOU’RE IN</span><h1>Waiting for<br /><em>the host…</em></h1><p>Keep your paws ready, {myPlayer.name}.</p></section>
      ) : (
        <section className="player-center panel buzzer-stage"><span className="panel-kicker">ROUND {room.currentRound + 1} · LISTEN UP</span><button className="paw-button" onClick={() => void paw()} aria-label="Paw the buzzer"><span>🐾</span><b>PAW IN</b></button><p>Tap when you know the song</p></section>
      )}
      <footer className="player-bottom"><div className="mini-scoreboard"><span className="panel-kicker">YOUR CREW</span>{sortedPlayers.slice(0, 4).map((player) => <span key={player.identity.toHexString()} className={player.identity.toHexString() === identityHex ? 'mini-score me' : 'mini-score'}>{player.name}<b>{player.score}</b></span>)}</div><span className="phone-paw">🐾</span></footer>
      {error && <div className="toast-error" role="status">{error}<button onClick={() => setError('')}>×</button></div>}
      {isMyTurn && <SongSearchModal secondsLeft={secondsLeft} onSelect={guess} />}
    </main>
  );
}
