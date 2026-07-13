import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Robust keyword and heuristic filter (copied from src/pipeline/index.js for testing)
const isLikelyLeadRequest = (text) => {
  const lower = text.toLowerCase();
  
  if (lower.length > 600) return false; 

  const blacklist = [
    'http', 'www', '.com', '.co.ke', 
    'job', 'vacancy', 'hiring', 'cv', 'interview',
    'news', 'breaking', 'politics', 'update',
    'subscribe', 'youtube', 'tiktok', 'instagram', 'follow',
    'fully furnished', 'kes/night', 'kes / night', 'kes per night', 'ksh/night', 'kshs/night',
    'for sale', 'acre', 'plot', 'title deed', 'buy', 'buying',
    'data bundles', 'sofa', 'curtains', 'shoes', 'clothes', 'delivery', 'wholesale'
  ];
  if (blacklist.some(k => lower.includes(k))) return false;

  const keywords = [
    'book', 'stay', 'room', 'bedroom', 'guest', 'night', 
    'budget', 'kes', 'ksh', 'shilling', 'apartment', 'place', 
    'house', 'rent', 'looking for', 'airbnb', 'bnb', 
    'natafuta', 'need a', 'needs a', 'client needs', 'any', 'vacant',
    'chumba', 'nyumba', 'keja', 'hostel', 'studio',
    'check in', 'check out', 'check-in', 'check-out',
    'available', 'availability', 'reservation', 'reserve',
    '1b', '2b', '3b', '1br', '2br', '3br', '1 bed', '2 bed', '3 bed'
  ];
  
  return keywords.some(k => lower.includes(k));
};

const run = async () => {
  const dataPath = path.resolve(__dirname, 'data/chat-export.txt');
  
  if (!fs.existsSync(dataPath)) {
    console.error(`Error: Could not find ${dataPath}`);
    console.log('Please export your WhatsApp chat (Without Media) and save it as "chat-export.txt" inside tests/data/');
    return;
  }

  const content = fs.readFileSync(dataPath, 'utf-8');
  
  // Basic parser for WhatsApp export format
  // Format typically looks like: [DD/MM/YYYY, HH:MM:SS] Sender Name: Message
  // Or: M/D/YY, HH:MM AM - Sender Name: Message
  
  const lines = content.split('\n');
  const messages = [];
  let currentMessage = null;

  for (const line of lines) {
    // Regex to match the start of a new message (date and time)
    const newMsgRegex = /^\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\]?\s-?\s?(.*?):\s(.*)/;
    const match = line.match(newMsgRegex);

    if (match) {
      if (currentMessage) {
        messages.push(currentMessage);
      }
      currentMessage = {
        sender: match[1],
        text: match[2].trim()
      };
    } else if (currentMessage) {
      // Continuation of a multi-line message
      currentMessage.text += '\n' + line.trim();
    }
  }
  
  if (currentMessage) {
    messages.push(currentMessage);
  }

  console.log(`Parsed ${messages.length} messages from the export file.\n`);

  let passed = 0;
  let blocked = 0;
  
  console.log('--- MESSAGES THAT PASSED THE FILTER ---');
  for (const msg of messages) {
    if (isLikelyLeadRequest(msg.text)) {
      passed++;
      console.log(`[PASS] ${msg.sender}: ${msg.text.substring(0, 100)}${msg.text.length > 100 ? '...' : ''}`);
    } else {
      blocked++;
    }
  }

  console.log('\n--- SUMMARY ---');
  console.log(`Total Messages: ${messages.length}`);
  console.log(`Passed (Sent to LLM): ${passed}`);
  console.log(`Blocked (Tokens saved): ${blocked}`);
};

run();
