const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const outPath = path.join(__dirname, '..', 'env.json');

if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      env[k] = v;
    }
  });

  fs.writeFileSync(outPath, JSON.stringify(env, null, 2));
  console.log('Successfully synced .env to env.json');
} else {
  console.warn('.env file not found.');
}
