import fs from 'fs';
import dotenv from 'dotenv';
import { validateEnv } from '../src/config/env.js';

dotenv.config();

try {
  const { dataDir } = validateEnv();
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
  console.log(JSON.stringify({ status: 'ok', dataDir }));
} catch (error) {
  console.error(JSON.stringify({ status: 'error', message: error.message }));
  process.exit(1);
}
