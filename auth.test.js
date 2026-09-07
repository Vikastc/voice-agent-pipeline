const assert = require('assert');
const http = require('http');
const app = require('./server.js');

async function runTests() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`\n🧪 Testing Authentication & Quota System on port ${port}...`);

  try {
    // 1. Health check returns auth info
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const health = await healthRes.json();
    assert.strictEqual(health.authRequired, true);
    assert.strictEqual(health.tokenLimitPerUser, 20000);
    console.log('✓ Health check reports auth and 20k token limit');

    // 2. Unauthenticated access to /api/llm is blocked
    const unauthLlm = await fetch(`${baseUrl}/api/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userText: 'Hello' }),
    });
    assert.strictEqual(unauthLlm.status, 401);
    console.log('✓ Unauthenticated request to /api/llm rejected (401)');

    // 3. Login with invalid key is rejected
    const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'wrong-key-xyz' }),
    });
    assert.strictEqual(badLoginRes.status, 401);
    console.log('✓ Invalid access key rejected (401)');

    // 4. Login with valid key succeeds and returns signed token
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'demo-2026' }),
    });
    assert.strictEqual(loginRes.status, 200);
    const authData = await loginRes.json();
    assert.strictEqual(authData.ok, true);
    assert.strictEqual(authData.user, 'demo-2026');
    assert.strictEqual(authData.maxTokens, 20000);
    assert(typeof authData.token === 'string' && authData.token.includes('.'));
    const token = authData.token;
    console.log('✓ Valid login issued signed token with 20k quota');

    // 5. /api/auth/me verifies valid token
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(meRes.status, 200);
    const me = await meRes.json();
    assert.strictEqual(me.user, 'demo-2026');
    assert.strictEqual(me.maxTokens, 20000);
    assert.strictEqual(me.tokensRemaining, me.maxTokens - me.tokensUsed);
    console.log('✓ /api/auth/me successfully verified token and balance');

    // 6. Tampered token is rejected
    const tamperedRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}tampered` },
    });
    assert.strictEqual(tamperedRes.status, 401);
    console.log('✓ Tampered HMAC token rejected (401)');

    // 7. Simulating user at token limit (20,000 / 20,000)
    // Create an expired quota token by forging or manipulating
    const [h, b] = token.split('.');
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    payload.tokensUsed = 20000; // exhausted

    // Sign this test payload using the server's secret by updating .usage.json directly
    const fs = require('fs');
    const path = require('path');
    const usageFile = path.join(__dirname, '.usage.json');
    let usage = {};
    try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch {}
    usage['quota-test-user'] = 20000;
    fs.writeFileSync(usageFile, JSON.stringify(usage));

    // Login as quota-test-user if in allowed keys
    // Let's test with a fresh token where tokensUsed = 20000
    const crypto = require('crypto');
    const authSecret = process.env.AUTH_SECRET ||
      crypto.createHash('sha256').update(process.env.OPENAI_API_KEY || 'voice-agent-auth-default-salt').digest('hex');
    const fullBody = Buffer.from(JSON.stringify({
      sub: 'demo-2026',
      tokensUsed: 20000,
      maxTokens: 20000,
      exp: Date.now() + 100000,
    })).toString('base64url');
    const fullSig = crypto.createHmac('sha256', authSecret).update(`${h}.${fullBody}`).digest('base64url');
    const exhaustedToken = `${h}.${fullBody}.${fullSig}`;

    const quotaLlmRes = await fetch(`${baseUrl}/api/llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${exhaustedToken}`,
      },
      body: JSON.stringify({ userText: 'Should be blocked' }),
    });
    assert.strictEqual(quotaLlmRes.status, 403);
    const quotaErr = await quotaLlmRes.json();
    assert(quotaErr.error.includes('Token limit reached'));
    console.log('✓ Quota enforcement correctly blocked user at 20,000 tokens (403)');

    console.log('\n🎉 All authentication & quota tests passed successfully!\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
