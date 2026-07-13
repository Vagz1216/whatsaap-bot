import fs from 'fs';
import path from 'path';

const REQUIRED_ENV = [
  'WC_BASE_URL',
  'WC_CONSUMER_KEY',
  'WC_CONSUMER_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID'
];

const LLM_PROVIDER_ENV = [
  'AZURE_OPENAI_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY'
];

const PLACEHOLDER_VALUES = new Set([
  'your_wc_key',
  'your_wc_secret',
  'your_telegram_bot_token',
  'your_telegram_chat_id'
]);

export const getDataDir = () => path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

export const validateEnv = () => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  const placeholders = REQUIRED_ENV.filter((name) => PLACEHOLDER_VALUES.has(process.env[name]));
  const hasCompleteAzure = Boolean(
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME
  );
  const hasLlmProvider = hasCompleteAzure || ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'].some((name) => Boolean(process.env[name]));

  const errors = [];
  if (missing.length > 0) {
    errors.push(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (placeholders.length > 0) {
    errors.push(`Replace placeholder environment variables: ${placeholders.join(', ')}`);
  }

  if (!hasLlmProvider) {
    errors.push(`At least one LLM provider key is required: ${LLM_PROVIDER_ENV.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  const dataDir = getDataDir();
  fs.mkdirSync(path.join(dataDir, 'wa-auth'), { recursive: true });
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);

  return { dataDir };
};
