// netlify/functions/auth.js
// Handles Whoop OAuth flow

const CLIENT_ID     = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI  = process.env.WHOOP_REDIRECT_URI; // set in Netlify env vars

exports.handler = async (event) => {
  const { code, action } = event.queryStringParameters || {};

  // Step 1: Redirect user to Whoop login
  if (action === 'login') {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'read:recovery read:sleep read:body_measurement read:workout read:cycles read:profile offline',
    });
    return {
      statusCode: 302,
      headers: { Location: `https://api.prod.whoop.com/oauth/oauth2/auth?${params}` }
    };
  }

  // Step 2: Exchange code for tokens
  if (code) {
    try {
      const resp = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
        })
      });
      const tokens = await resp.json();
      if (!tokens.access_token) throw new Error('No access token received');

      // Store tokens in cookie and redirect to app
      const cookieVal = encodeURIComponent(JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      }));

      return {
        statusCode: 302,
        headers: {
          'Set-Cookie': `whoop_tokens=${cookieVal}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          Location: '/'
        }
      };
    } catch (e) {
      return { statusCode: 500, body: `Auth error: ${e.message}` };
    }
  }

  return { statusCode: 400, body: 'Bad request' };
};
