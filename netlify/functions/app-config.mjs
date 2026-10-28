// app-config.mjs — public settings the browser needs before connecting.
// BUFFER_CLIENT_ID is public OAuth metadata (not a secret).

import { json } from "./_lib.mjs";

export default async function handler() {
  return json({
    bufferClientId: process.env.BUFFER_CLIENT_ID || "",
    bufferScope: process.env.BUFFER_OAUTH_SCOPE || "posts:write posts:read account:read offline_access",
  });
}

export const config = { path: "/api/config" };
