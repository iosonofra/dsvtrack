import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../node_modules/@askjo/camofox-browser/server.js', import.meta.url));
const environment = {
  ...process.env,
  CAMOFOX_PORT: process.env.CAMOFOX_PORT || '9377',
  CAMOFOX_BIND_HOST: '127.0.0.1',
  CAMOFOX_CRASH_REPORT_ENABLED: 'false',
  CAMOFOX_PROFILE_DIR: process.env.CAMOFOX_PROFILE_DIR || fileURLToPath(new URL('../data/camofox-profile', import.meta.url)),
};

delete environment.PROXY_HOST;
delete environment.PROXY_PORT;
delete environment.PROXY_USERNAME;
delete environment.PROXY_PASSWORD;

console.log(`Camofox beta in ascolto solo su http://127.0.0.1:${environment.CAMOFOX_PORT}`);
console.log('Telemetria, proxy e importazione cookie non sono abilitati.');
const child = spawn(process.execPath, [serverPath], { stdio: 'inherit', env: environment });
child.on('exit', (code) => process.exit(code ?? 0));
