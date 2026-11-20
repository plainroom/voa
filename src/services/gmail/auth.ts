import { revoked, SignedOutError } from "../oauth/signedOut";
import { OAUTH_CALLBACK_PORT, codeChallenge, randomToken, receiveOAuthRedirect } from "../oauth/pkce";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface UserInfo {
  email: string;
  name: string;
  picture: string;
}

/**
 * Full OAuth2 + PKCE flow:
 * 1. Start localhost callback server (Rust side)
 * 2. Open browser to Google consent screen
 * 3. Server captures the redirect with auth code
 * 4. Exchange code for tokens
 * 5. Fetch user profile
 */
export async function startOAuthFlow(
  clientId: string,
  clientSecret?: string,
): Promise<{ tokens: TokenResponse; userInfo: UserInfo }> {
  if (!clientSecret) {
    throw new Error(
      "Client Secret is not configured. Go to Settings → Google API to add it.",
    );
  }

  const codeVerifier = randomToken();
  const challenge = await codeChallenge(codeVerifier);
  const oauthState = randomToken();
  const redirectUri = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state: oauthState,
  });

  const code = await receiveOAuthRedirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, oauthState);

  const tokens = await exchangeCodeForTokens(
    code,
    clientId,
    redirectUri,
    codeVerifier,
    clientSecret,
  );

  // Fetch user info
  const userInfo = await fetchUserInfo(tokens.access_token);

  return { tokens, userInfo };
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
  clientSecret?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  };
  if (clientSecret) params.client_secret = clientSecret;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    refresh_token: refreshToken,
    client_id: clientId,
    grant_type: "refresh_token",
  };
  if (clientSecret) params.client_secret = clientSecret;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    const error = await response.text();
    if (revoked(error)) throw new SignedOutError("Google");
    throw new Error(`Token refresh failed: ${error}`);
  }

  return response.json();
}

async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    throw new Error("Failed to fetch user info");
  }

  return response.json();
}
