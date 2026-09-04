# Kanban Web UI

This package contains the Kanban frontend served by the runtime.

## Stack

- React + TypeScript + Vite
- Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/vite`)
- Radix UI headless primitives (`@radix-ui/react-*`)
- lucide-react icons
- Drag and drop via `@hello-pangea/dnd`
- Vitest
- Playwright

## Telemetry

PostHog telemetry is enabled in official release builds published from this repository.
For local builds, forks, and source builds, telemetry is off unless you set a PostHog key.

1. Copy `web-ui/.env.example` to `web-ui/.env.local`.
2. Set `POSTHOG_KEY` to your PostHog project key.
3. Keep `POSTHOG_HOST` set to `https://data.cline.bot` unless you need a different ingestion host.

When `POSTHOG_KEY` is empty or unset, the app does not initialize PostHog.

Current behavior:
- Session replay is disabled.
- Autocapture is disabled. This means PostHog does not automatically capture clicks, form edits, or other raw DOM interactions.
- Pageview events are enabled for active user metrics.

## Scripts

- `npm run dev`
- `npm run build`
- `npm run preview`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run test:watch`
- `npm run e2e`
