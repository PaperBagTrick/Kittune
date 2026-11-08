import { useEffect, useState } from 'react';

type GuessResult = 'CORRECT' | 'WRONG' | 'TIMEOUT' | 'ELIMINATED' | null;
type Props = {
  roomCode: string;
  round: number;
  result?: string | null;
  playerName?: string | null;
  sequence: number;
};

type VisibleResult = Exclude<GuessResult, null>;

export default function GuessResultOverlay({ roomCode, round, result, playerName, sequence }: Props) {
  const [visibleResult, setVisibleResult] = useState<VisibleResult | null>(null);
  const [visiblePlayerName, setVisiblePlayerName] = useState('');
  const recognizedResult: GuessResult = result === 'CORRECT' || result === 'WRONG' || result === 'TIMEOUT' || result === 'ELIMINATED' ? result : null;

  useEffect(() => {
    if (!recognizedResult || sequence === 0) {
      setVisibleResult(null);
      setVisiblePlayerName('');
      return;
    }

    setVisibleResult(recognizedResult);
    setVisiblePlayerName(playerName ?? 'A player');
    const timer = window.setTimeout(() => setVisibleResult(null), 2800);
    return () => window.clearTimeout(timer);
  }, [roomCode, round, recognizedResult, playerName, sequence]);

  if (!visibleResult) return null;

  const content = {
    CORRECT: { icon: '🎉', title: 'Correct!', detail: `${visiblePlayerName} earned a point.` },
    WRONG: { icon: '🙀', title: 'Not quite', detail: `${visiblePlayerName} loses a point.` },
    TIMEOUT: { icon: '⏰', title: "Time's up", detail: `${visiblePlayerName} ran out of time.` },
    ELIMINATED: { icon: '🚫', title: 'Out of the game', detail: `${visiblePlayerName} reached −3 points and is eliminated.` },
  }[visibleResult];

  return (
    <div className={`guess-result-backdrop guess-result-${visibleResult.toLowerCase()}`} role="status" aria-live="assertive">
      <section className="guess-result-card panel">
        <span className="guess-result-icon" aria-hidden="true">{content.icon}</span>
        <p className="panel-kicker">GUESS RESULT</p>
        <h2>{content.title}</h2>
        <p>{content.detail}</p>
      </section>
    </div>
  );
}
