const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const credentialsPath = path.resolve(
  __dirname,
  "../credentials/oauth-drive-client.json"
);

const tokenPath = path.resolve(
  __dirname,
  "../credentials/drive-token.json"
);

function createOAuthClient() {
  const credentials = JSON.parse(
    fs.readFileSync(credentialsPath, "utf8")
  );

  const config = credentials.web || credentials.installed;

  if (!config) {
    throw new Error("Konfigurasi OAuth Client tidak valid.");
  }

  return new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    "http://localhost:3000/oauth2callback"
  );
}

function getDriveAuthUrl() {
  const oauth2Client = createOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"]
  });
}

async function saveDriveToken(code) {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  fs.writeFileSync(
    tokenPath,
    JSON.stringify(tokens, null, 2)
  );

  return tokens;
}

function getDriveClient() {
  const oauth2Client = createOAuthClient();

  if (!fs.existsSync(tokenPath)) {
    throw new Error("Token Google Drive belum tersedia.");
  }

  const tokens = JSON.parse(
    fs.readFileSync(tokenPath, "utf8")
  );

  oauth2Client.setCredentials(tokens);

  return google.drive({
    version: "v3",
    auth: oauth2Client
  });
}

module.exports = {
  createOAuthClient,
  getDriveAuthUrl,
  saveDriveToken,
  getDriveClient,
  tokenPath
};