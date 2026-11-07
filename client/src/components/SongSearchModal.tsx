import { useEffect, useRef, useState } from 'react';

type SearchResult = {
  trackId: number;
  trackName: string;
  artistName: string;
  artworkUrl100: string;
};

type Props = {
  secondsLeft: number;
  onSelect: (trackId: number) => Promise<void>;
};

export default function SongSearchModal({ secondsLeft, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) {
      setResults([]);
      setError('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ term: cleanQuery, entity: 'song', limit: '5' });
        const response = await fetch(`https://itunes.apple.com/search?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Search is taking a cat nap. Try again.');
        const data = await response.json() as { results?: SearchResult[] };
        setResults(data.results ?? []);
        if (!data.results?.length) setError('No tracks found. Try another search.');
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Search failed. Try again.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="guess-modal" role="dialog" aria-modal="true" aria-labelledby="guess-title">
        <div className="guess-modal-top"><span className="panel-kicker">YOUR MOMENT</span><div className="countdown-ring"><b>{secondsLeft}</b><small>SEC</small></div></div>
        <div className="guess-paw">🐾</div>
        <h2 id="guess-title">Name that <em>tune!</em></h2>
        <p>Search fast, music cat.</p>
        <label className="search-box"><span>⌕</span><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search song title or artist…" /></label>
        <div className="search-results" aria-live="polite">
          {loading && <p className="search-message"><span className="spinner" /> Searching iTunes…</p>}
          {!loading && error && <p className="search-message">{error}</p>}
          {!loading && results.map((result) => (
            <button className="search-result" key={result.trackId} onClick={() => void onSelect(result.trackId)}>
              <img src={result.artworkUrl100} alt="" />
              <span><b>{result.trackName}</b><small>{result.artistName}</small></span>
              <span className="result-arrow">→</span>
            </button>
          ))}
        </div>
        <div className="guess-footer"><span>Pick the right track to score a point</span><span>⌘ KITTUNE</span></div>
      </section>
    </div>
  );
}
