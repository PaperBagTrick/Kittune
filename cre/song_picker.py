import argparse
import json
import logging
import random
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEEZER_URL = "https://api.deezer.com/search"
ITUNES_URL = "https://itunes.apple.com/search"
LOG_DIR = Path("logs")
OUTPUT_DIR = Path("output")


def configure_logging() -> None:
    LOG_DIR.mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(LOG_DIR / "song_picker.log", encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )


def get_json(url: str, service: str) -> dict:
    request = Request(url, headers={"User-Agent": "random-song-picker/1.0"})
    try:
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    except HTTPError as exc:
        logging.error("%s returned HTTP %s", service, exc.code)
        raise
    except URLError as exc:
        logging.error("Could not reach %s: %s", service, exc.reason)
        raise


def deezer_results(query: str) -> list[dict]:
    logging.info("Searching Deezer for %r", query)
    payload = get_json(f"{DEEZER_URL}?{urlencode({'q': query, 'limit': 10})}", "Deezer")
    if payload.get("error"):
        raise RuntimeError(payload["error"].get("message", "Unknown Deezer API error"))
    results = []
    for track in payload.get("data", []):
        results.append({
            "source": "Deezer",
            "id": track.get("id"),
            "title": track.get("title"),
            "artist": (track.get("artist") or {}).get("name"),
            "album": (track.get("album") or {}).get("title"),
            "duration_seconds": track.get("duration"),
            "track_url": track.get("link"),
            "preview_url": track.get("preview"),
        })
    logging.info("Deezer returned %d tracks", len(results))
    return results


def itunes_results(query: str) -> list[dict]:
    logging.info("Searching iTunes for %r", query)
    params = {"term": query, "media": "music", "entity": "song", "limit": 10}
    payload = get_json(f"{ITUNES_URL}?{urlencode(params)}", "iTunes")
    results = []
    for track in payload.get("results", []):
        results.append({
            "source": "iTunes",
            "id": track.get("trackId"),
            "title": track.get("trackName"),
            "artist": track.get("artistName"),
            "album": track.get("collectionName"),
            "duration_seconds": round(track["trackTimeMillis"] / 1000) if track.get("trackTimeMillis") else None,
            "track_url": track.get("trackViewUrl"),
            "preview_url": track.get("previewUrl"),
        })
    logging.info("iTunes returned %d tracks", len(results))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Search Deezer and iTunes, then pick a random matching track.")
    parser.add_argument("query", help="Song title, artist, or both")
    args = parser.parse_args()
    configure_logging()

    results = []
    for service, search in (("Deezer", deezer_results), ("iTunes", itunes_results)):
        try:
            results.extend(search(args.query))
        except (HTTPError, URLError, RuntimeError, TimeoutError, json.JSONDecodeError) as exc:
            logging.error("Skipping %s results: %s", service, exc)

    if not results:
        logging.error("No tracks found from either service for %r", args.query)
        return 1

    track = random.choice(results)
    logging.info("Randomly selected %r by %r from %s (%d candidates)",
                 track["title"], track["artist"], track["source"], len(results))
    OUTPUT_DIR.mkdir(exist_ok=True)
    output_path = OUTPUT_DIR / "track.json"
    output_path.write_text(json.dumps(track, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    logging.info("Saved selected track to %s", output_path)
    print(json.dumps(track, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
