import { useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import HostView from './views/HostView';
import PlayerView from './views/PlayerView';

type Screen = 'home' | 'host' | 'player';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const { isActive, connectionError } = useSpacetimeDB();

  if (screen === 'host') return <HostView onBack={() => setScreen('home')} />;
  if (screen === 'player') return <PlayerView onBack={() => setScreen('home')} />;

  return (
    <main className="landing-shell">
      <div className="landing-orbit orbit-one" />
      <div className="landing-orbit orbit-two" />
      <div className="tunee-hero" aria-hidden="true">
        <span className="tunee-pulse tunee-pulse-one" />
        <span className="tunee-pulse tunee-pulse-two" />
        <img src="/Tunee.png" alt="" />
      </div>
      <header className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">🐾</span>
        <span>KITTUNE</span>
      </header>
      <section className="hero-copy">
        <p className="eyebrow">Multiplayer MUSIC GAME</p>
        <h1>Hear it,<br /><span>Recognize it,</span><br />Paw the buzzer!</h1>
        <p className="hero-note">A little music, a lot of friendly competition.</p>
        <div className="entry-cards">
          <button className="entry-card entry-host" onClick={() => setScreen('host')}>
            <span className="entry-icon">🎛️</span>
            <span className="entry-title">Host a room</span>
            <span className="entry-caption">Set up the big screen</span>
            <span className="entry-arrow">↗</span>
          </button>
          <button className="entry-card entry-player" onClick={() => setScreen('player')}>
            <span className="entry-icon">🐈</span>
            <span className="entry-title">Join a game</span>
            <span className="entry-caption">Grab your phone and play</span>
            <span className="entry-arrow">↗</span>
          </button>
        </div>
      </section>
      <footer className="landing-footer">
        <span className={`connection-dot ${isActive ? 'is-online' : ''}`} />
        <span>{isActive ? 'Connected to the game server' : connectionError ? 'Server connection failed' : 'Connecting to the game server…'}</span>
        <span className="footer-paw">Made for music cats&nbsp; ✦</span>
      </footer>
    </main>
  );
}
