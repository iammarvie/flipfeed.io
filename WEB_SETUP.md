# Flipfeed Web

Flipfeed Web is a static progressive web app. Decks, review history, schedules, and imported media are stored privately in the browser with IndexedDB. No backend or Firebase project is required for the local-first version.

## Run locally

From this directory:

```sh
python3 server.py
```

Then open `http://localhost:8000`. Do not open `index.html` directly because service workers and the SQLite WebAssembly module require HTTP.

## Publish with GitHub Pages

1. Create a GitHub repository and push this directory.
2. In the repository, open **Settings > Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the branch, choose `/ (root)`, and save.
5. Open the Pages URL after deployment completes.

All app links and worker paths are relative, so the app works from a project URL such as `https://username.github.io/flipfeed/`.

## Data and backups

- Deleting the browser's website data deletes the local library.
- Use **Library tools > Export backup** regularly.
- Importing a backup restores decks, adaptive scheduling state, review history, and embedded media.
- Firebase account sync is intentionally a later layer. Records already include stable IDs, timestamps, and local sync state.

## Anki compatibility

The importer supports packages containing `collection.anki2` or `collection.anki21`. Packages containing only `collection.anki21b` must be exported from Anki with legacy compatibility enabled.

The checked-in `vendor/` files are pinned copies of JSZip 3.10.1 and sql.js 1.13.0 so imports and offline use do not depend on a CDN.
