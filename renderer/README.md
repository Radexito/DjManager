# DJ Manager — Renderer

This is the React/Vite frontend for DJ Manager. It runs inside Electron's renderer process and communicates with the main process exclusively through `window.api` (exposed by `src/preload.js`).

## Stack

- **React 19** + **Vite 7**
- **@dnd-kit** — drag-and-drop for playlist track reordering
- **react-window** — virtualised track list (`FixedSizeList`)
- **Vitest** + **React Testing Library** — unit and component tests
- **ESLint 9** + **Prettier** — linting and formatting

## Structure

```
src/
  main.jsx              # React entry point
  App.jsx               # Root component — deps progress overlay, routing between views
  MusicLibrary.jsx      # Main track list, search bar, context menu, pagination
  Sidebar.jsx           # Playlist sidebar
  PlayerBar.jsx         # Playback controls, seekbar with intro/outro zones
  PlayerContext.jsx     # Global player state (queue, shuffle, repeat) via React Context
  SearchBar.jsx         # Advanced search input with chip filters
  searchParser.js       # Parses DJ-specific search queries (BPM, KEY, GENRE, etc.)
  TrackDetails.jsx      # Track details / bulk-edit panel
  SettingsModal.jsx     # App settings modal
  __tests__/            # Component and integration tests
```

## IPC

The renderer has no direct Node.js access. All communication goes through `window.api`:

```js
window.api.getTracks(filters); // fetch paginated track list
window.api.importAudioFiles(paths); // trigger import pipeline
window.api.onTrackUpdated(callback); // listen for analysis results
// ...etc — see src/preload.js for the full surface
```

All `window.api.on*()` listeners return a cleanup function — always call it in `useEffect` cleanup.

## Commands

```bash
# Install dependencies
npm install

# Start dev server (Vite at http://localhost:5173)
npm run dev

# Build for production (outputs to dist/)
npm run build

# Lint
npm run lint

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

> **Note:** Run `npm run dev` from the repo root (`npm run dev` there starts both Electron and Vite together). The renderer dev server alone is useful for rapid UI iteration without Electron.

## Testing

Tests use **Vitest** with **jsdom** and **React Testing Library**. `window.api` is mocked globally in `src/__tests__/setup.js`.

```bash
npm test                  # run all tests once
npm run test:watch        # watch mode
npm run test:coverage     # with v8 coverage report
```
