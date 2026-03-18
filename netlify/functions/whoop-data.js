// netlify/functions/whoop-data.js
// Fetches recovery, sleep, and body data from Whoop API

const CLIENT_ID     = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
}

async function refreshTokens(refresh_token) {
  const resp = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
  });
  return resp.json();
}

async function whoopGet(endpoint, token) {
  const resp = await fetch(`https://api.prod.whoop.com/developer/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Whoop API error: ${resp.status}`);
  return resp.json();
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const cookies = parseCookies(event.headers.cookie || '');
    if (!cookies.whoop_tokens) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'not_authenticated' }) };
    }

    let tokens = JSON.parse(cookies.whoop_tokens);

    // Refresh token if expired
    if (Date.now() > tokens.expires_at - 60000) {
      const refreshed = await refreshTokens(tokens.refresh_token);
      if (!refreshed.access_token) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'token_expired' }) };
      }
      tokens = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + (refreshed.expires_in * 1000)
      };
    }

    const access = tokens.access_token;
    const { days = '14' } = event.queryStringParameters || {};
    const limit = Math.min(parseInt(days), 30);

    // Fetch all data in parallel
    const [recoveryData, sleepData, cycleData, profileData] = await Promise.all([
      whoopGet(`recovery?limit=${limit}`, access).catch(() => ({ records: [] })),
      whoopGet(`activity/sleep?limit=${limit}`, access).catch(() => ({ records: [] })),
      whoopGet(`cycle?limit=${limit}`, access).catch(() => ({ records: [] })),
      whoopGet('user/profile/basic', access).catch(() => ({})),
    ]);

    // Process and combine by date
    const byDate = {};

    // Recovery scores
    (recoveryData.records || []).forEach(r => {
      const date = r.created_at?.slice(0, 10);
      if (!date) return;
      if (!byDate[date]) byDate[date] = {};
      byDate[date].recovery = {
        score: r.score?.recovery_score,
        hrv: r.score?.hrv_rmssd_milli,
        rhr: r.score?.resting_heart_rate,
        spo2: r.score?.spo2_percentage,
        skin_temp: r.score?.skin_temp_celsius,
      };
    });

    // Sleep data
    (sleepData.records || []).forEach(s => {
      const date = s.start?.slice(0, 10);
      if (!date) return;
      if (!byDate[date]) byDate[date] = {};
      const perf = s.score?.stage_summary;
      byDate[date].sleep = {
        duration_hours: s.score?.sleep_needed?.baseline_milli
          ? Math.round(((s.end ? new Date(s.end) - new Date(s.start) : 0) / 3600000) * 10) / 10
          : null,
        actual_hours: s.end ? Math.round((new Date(s.end) - new Date(s.start)) / 3600000 * 10) / 10 : null,
        efficiency: s.score?.sleep_efficiency_percentage,
        deep_pct: perf ? Math.round((perf.total_slow_wave_sleep_time_milli / (perf.total_in_bed_time_milli || 1)) * 100) : null,
        rem_pct: perf ? Math.round((perf.total_rem_sleep_time_milli / (perf.total_in_bed_time_milli || 1)) * 100) : null,
        disturbances: s.score?.disturbances,
        quality_score: s.score?.sleep_performance_percentage,
      };
    });

    // Strain from cycles
    (cycleData.records || []).forEach(c => {
      const date = c.start?.slice(0, 10);
      if (!date) return;
      if (!byDate[date]) byDate[date] = {};
      byDate[date].strain = {
        score: c.score?.strain,
        avg_hr: c.score?.average_heart_rate,
        max_hr: c.score?.max_heart_rate,
        kilojoules: c.score?.kilojoule,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        profile: {
          first_name: profileData.first_name,
          last_name: profileData.last_name,
        },
        data: byDate,
        fetched_at: new Date().toISOString(),
      })
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
