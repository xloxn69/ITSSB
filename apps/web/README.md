# apps/web — family and staff web

Android families get the same tracking meanings as the iPhone app; staff
review routes and manage buses. Spec: [docs/12](../../docs/12_ADMIN_AND_ANDROID_WEB.md).

## Run it with fictional data

```sh
bun run dev            # then open http://localhost:5173/?fixture=live
```

`?fixture=` lists every screen state. Fixtures exist only in development; a
production build contains none and never shows an invented position.

## Run it against a dev deployment

1. Finish the backend sign-in setup (backend README, Clerk section), including
   the Clerk JWT template named `convex`.
2. Copy `.env.example` to `.env.local` and set `VITE_CONVEX_URL` and
   `VITE_CLERK_PUBLISHABLE_KEY`. Both are public values; never put a secret key
   in a `VITE_` variable.
3. `bun run dev` and sign in. Without both values the site shows "Sign-in isn't
   set up", which fails closed.

## Checks

`bun run test` covers state mapping, freshness and clocks, and the live
source. `bun run screenshots [dir]` captures every screen at phone and desktop
width, light and dark (CI uploads them as the `web-screenshots` artifact).
