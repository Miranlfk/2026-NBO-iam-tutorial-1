# Wayfinder Travel

Wayfinder Travel is a Vite + React sample web application secured with the Asgardeo React SDK. It demonstrates a travel booking experience, with access management powered by Asgardeo.

## Features

- Flight booking user interface
- Featured flight deals and hotel recommendations
- Sign in with Asgardeo
- Sign up with Asgardeo
- Sign out from the authenticated session

## Asgardeo Configuration

1. Sign into [Asgardeo Console](https://console.asgardeo.io).

2. Go to **Applications** > **New Application** and select **Single Page Application**.

3. Provide the required details.

- Name: a meaningful name for the frontend application.
- Authorized redirect URL: `http://localhost:5173`

## On Your Machine

1. Install dependencies.

```bash
npm install
```

2. Create a local `.env` file from `.env.example` and update the values according to your Asgardeo organization.

```bash
cp .env.example .env
```

3. Start the development server:

```bash
npm run dev
```

Open the app at:

```text
http://localhost:5173/
```

## Build

Create a production build:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Container image

The `Dockerfile` builds the app once and serves it with nginx (unprivileged,
port 8080) with a fallback to `index.html` for client-side routes. Configuration
is read when the container starts, not at build time: the entrypoint writes
`/env-config.js` from the `VITE_*` environment variables listed in
`.env.example`, and `src/config.js` prefers those values over the build-time
ones. The same image therefore works for any domain.

```bash
docker build -t wayfinder/frontend .
docker run --rm -p 8080:8080 \
  -e VITE_ASGARDEO_CLIENT_ID=<client-id> \
  -e VITE_ASGARDEO_BASE_URL=https://api.asgardeo.io/t/<org> \
  -e VITE_API_BASE_URL=https://api.example.com \
  wayfinder/frontend
```
