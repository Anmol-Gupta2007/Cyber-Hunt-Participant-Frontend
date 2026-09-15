# Cyber Hunt Participant Platform

## Run the challenge workspace

1. Install and start Docker Desktop. The execution API refuses to run user code until Docker is available.
2. From this folder, run `npm start`.
3. Open `http://localhost:3000/Final/login.html`, log in, then open `http://localhost:3000/challenge-workspace.html`.

`server.mjs` runs submitted Python only in an ephemeral Docker container with no network, read-only filesystem, a non-root user, CPU, memory, PID, and timeout limits. Public tests are used for **Test Run**; hidden tests are only used for **Submit** and are never returned to the browser. Submission records are written to `submissions.json` at runtime.

Do not open `challenge-workspace.html` directly when using code execution—the API requires the local server.
