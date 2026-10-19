#!/usr/bin/env node
// Gets the Google Calendar refresh token the "Marcar call" agent action uses.
// Usage: node apps/api/scripts/google-calendar-token.mjs <CLIENT_ID> <CLIENT_SECRET>
// Opens Google's consent page, receives the code on a local port and prints
// GOOGLE_CALENDAR_REFRESH_TOKEN. Needs only Node 18+, no dependencies.
import { createServer } from "node:http";
import { exec } from "node:child_process";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Uso: node apps/api/scripts/google-calendar-token.mjs <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const scopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly"
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const code = url.searchParams.get("code");
  if (!code) {
    response.end(url.searchParams.get("error") ?? "Sem código.");
    return;
  }
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code"
      })
    });
    const body = await tokenResponse.json();
    if (!body.refresh_token) throw new Error(JSON.stringify(body));
    response.end("Pronto! Pode fechar esta aba e voltar ao terminal.");
    console.log("\nCole no Portainer (variáveis do talk_api):\n");
    console.log(`GOOGLE_CALENDAR_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CALENDAR_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_CALENDAR_REFRESH_TOKEN=${body.refresh_token}\n`);
  } catch (error) {
    response.end("Falhou, veja o terminal.");
    console.error("Não consegui trocar o código pelo token:", error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

function redirectUri() {
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

server.listen(0, "127.0.0.1", () => {
  const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consent.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent"
  }).toString();
  console.log(`Abra este link e autorize com a conta Google da agenda:\n\n${consent}\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
  exec(`${opener} "${consent}"`, () => {});
});
