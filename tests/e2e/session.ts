// The server issues its session cookie only through the sign-in link, so the
// config passes this token to the server and each test opens the link first.
export const SESSION_TOKEN = process.env.MRX_E2E_SESSION_TOKEN || 'mrx-e2e-session-token-0123456789abcdef'
export const SIGN_IN_PATH = `/signin/${SESSION_TOKEN}`
