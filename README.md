# CORS Test Lab

A static, browser-based dashboard for testing real CORS behavior from the page origin. It is built for GitHub Pages and does not need a backend, proxy, database, API key, or server runtime.

## Features

- Request builder with URL, method, mode, credentials, timeout, headers, content type, and body.
- One-click probes for simple GET, JSON POST, credentials, custom headers, DELETE, and `no-cors`.
- Preflight detection based on method, headers, and content type.
- Result view with status, timing, visible response headers, readable body preview, and browser error classification.
- CORS diagnostics for failed preflights, missing readable responses, credentialed CORS pitfalls, mixed content, and opaque `no-cors` behavior.
- Saved test cases in `localStorage`, with JSON import/export.
- Copyable diagnostic report for API teams.

## Important Browser Limits

This app tests CORS exactly as a browser enforces it. It cannot bypass CORS.

- If the browser blocks a CORS response, JavaScript cannot read the blocked response headers or body.
- Browser-managed headers such as `Origin`, `Host`, `Cookie`, `Referer`, and `Sec-*` cannot be manually set.
- `no-cors` requests can produce opaque responses where status, headers, and body are intentionally hidden.
- Testing from GitHub Pages means your API sees the app origin as `https://<user>.github.io`.

## Local Development

```bash
npm ci
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Publish to GitHub Pages

1. Push this repository to GitHub.
2. In the GitHub repository, open `Settings > Pages`.
3. Set `Build and deployment > Source` to `GitHub Actions`.
4. Push to the `main` branch, or run the `Deploy to GitHub Pages` workflow manually.

The workflow builds the static app with Vite and deploys the `dist` artifact to GitHub Pages.

## License

MIT
