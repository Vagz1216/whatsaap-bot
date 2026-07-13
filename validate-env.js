import dotenv from 'dotenv';
import fs from 'fs';

// Load without overriding process.env
const envConfig = dotenv.parse(fs.readFileSync('.env'));

console.log("\n🔍 SECURE .ENV VALIDATOR (Keys are hidden)\n=========================================");

// 1. Check Azure Endpoint
const azureEndpoint = envConfig.AZURE_OPENAI_ENDPOINT || '';
if (!azureEndpoint) {
  console.log("❌ AZURE_OPENAI_ENDPOINT is empty.");
} else {
  try {
    const url = new URL(azureEndpoint);
    if (url.protocol !== 'https:') {
      console.log("❌ AZURE_OPENAI_ENDPOINT must start with 'https://'.");
    } else if (!azureEndpoint.includes('.openai.azure.com')) {
      console.log("⚠️ AZURE_OPENAI_ENDPOINT usually contains '.openai.azure.com'. Please double check it.");
    } else if (azureEndpoint.endsWith('/')) {
      console.log("⚠️ AZURE_OPENAI_ENDPOINT ends with a slash (/). Our code adds one automatically. Try removing the trailing slash.");
    } else {
      console.log("✅ AZURE_OPENAI_ENDPOINT URL format looks correct.");
    }
  } catch (e) {
    console.log(`❌ AZURE_OPENAI_ENDPOINT is an invalid URL format. (Got: ${azureEndpoint.substring(0, 5)}...)`);
  }
}

// 2. Check Groq
const groqKey = envConfig.GROQ_API_KEY || '';
if (groqKey.startsWith('gsk_')) {
  console.log("✅ GROQ_API_KEY starts with 'gsk_' (looks correct).");
} else if (groqKey) {
  console.log("❌ GROQ_API_KEY is present but doesn't start with 'gsk_'. Are you sure it's the right key?");
}

// 3. Check WooCommerce
const wcKey = envConfig.WC_CONSUMER_KEY || '';
const wcSecret = envConfig.WC_CONSUMER_SECRET || '';

if (wcKey.includes('your_wc_key') || wcSecret.includes('your_wc_secret')) {
  console.log("❌ WooCommerce keys are still set to the default placeholder values.");
} else if (!wcKey.startsWith('ck_') || !wcSecret.startsWith('cs_')) {
  console.log("❌ WooCommerce keys usually start with 'ck_' and 'cs_'. Please double check them.");
} else {
  console.log("✅ WooCommerce keys appear to be formatted correctly.");
}

console.log("=========================================\n");