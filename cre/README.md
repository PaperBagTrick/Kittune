# Random Song Picker

A small Python CLI that searches Deezer and the iTunes Search API, combines their matching song results, and randomly selects one. The selection is printed and saved as `output/track.json`. Timestamped activity is shown in the terminal and appended to `logs/song_picker.log`.

The APIs provide track metadata and preview URLs; this project does not download full songs. If one service is unavailable, results from the other can still be used.

## Requirements

Python 3.9 or newer. No third-party packages are needed.

## Run

```powershell
python .\song_picker.py "Daft Punk One More Time"
```

Replace the query with a title, artist, or both. The script requests up to 10 results from each API and picks randomly from the combined list, so each result has an equal chance of selection.

## Output and logs

- `output/track.json` — the selected track, including its source, track link, and preview URL.
- `logs/song_picker.log` — timestamped search counts, selection, and errors.

The same log messages are also printed in the terminal.

## APIs

- Deezer: `https://api.deezer.com/search`
- Apple iTunes Search: `https://itunes.apple.com/search`
