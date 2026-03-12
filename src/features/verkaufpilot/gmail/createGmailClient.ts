// src/features/verkaufpilot/gmail/createGmailClient.ts

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const CREDENTIALS_PATH = path.resolve(
  process.cwd(),
  "secrets/google-gmail-credentials.json",
);

const TOKEN_PATH = path.resolve(process.cwd(), "token.json");

type GoogleCredentialsFile = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
};

async function loadCredentialsFile(): Promise<GoogleCredentialsFile> {
  const raw = await fs.readFile(CREDENTIALS_PATH, "utf8");
  return JSON.parse(raw) as GoogleCredentialsFile;
}

async function loadSavedToken() {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveToken(tokens: unknown) {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

function getOauthConfig(credentials: GoogleCredentialsFile) {
  const key = credentials.installed ?? credentials.web;

  if (!key?.client_id || !key?.client_secret) {
    throw new Error("Invalid Google OAuth credentials file.");
  }

  const redirectUri =
    key.redirect_uris?.[0] ?? "http://localhost:3000/oauth2callback";

  return {
    clientId: key.client_id,
    clientSecret: key.client_secret,
    redirectUri,
  };
}

async function getAuthorizationCode(authUrl: string): Promise<string> {
  console.log("\nOpen this URL in your browser and complete login:\n");
  console.log(authUrl);
  console.log("");

  return await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", "http://localhost:3000");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`OAuth error: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing OAuth code.");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Authentication successful! Please return to the console.");

        server.close();
        resolve(code);
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.listen(3000, () => {
      console.log(
        "Waiting for OAuth callback on http://localhost:3000/oauth2callback ...",
      );
    });

    server.on("error", (error) => {
      reject(error);
    });
  });
}

async function authorize() {
  const credentials = await loadCredentialsFile();
  const { clientId, clientSecret, redirectUri } = getOauthConfig(credentials);

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );

  const savedToken = await loadSavedToken();
  if (savedToken) {
    oauth2Client.setCredentials(savedToken);
    return oauth2Client;
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  const code = await getAuthorizationCode(authUrl);
  const tokenResponse = await oauth2Client.getToken(code);

  if (!tokenResponse.tokens) {
    throw new Error("Google OAuth did not return tokens.");
  }

  oauth2Client.setCredentials(tokenResponse.tokens);
  await saveToken(tokenResponse.tokens);

  return oauth2Client;
}

export async function createGmailClient() {
  await fs.access(CREDENTIALS_PATH);

  const auth = await authorize();

  return google.gmail({
    version: "v1",
    auth,
  });
}
