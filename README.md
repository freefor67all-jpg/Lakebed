# DE Venom — Magic Hour

## Render Environment Variables

Add these in Render:

- `MAGIC_HOUR_API_KEY` = your Magic Hour API key
- `ADMIN_KEY` = your private admin key
- `PREMIUM_ACCESS_KEY` = your private Premium key
- `BASE_URL` = optional; Render's external URL is used automatically if available

Do not put API keys in GitHub or index.html.

## Render

Build Command:
`npm install`

Start Command:
`npm start`

The app listens on `PORT` supplied by Render.

## Features

- Magic Hour image-to-video
- 6-second video
- Audio enabled for video generation
- Magic Hour AI voice/audio
- Premium persistent links
- View-once links
- Admin price controls
- `/health` endpoint

Magic Hour free access is credit-limited; it is not unlimited free generation.
