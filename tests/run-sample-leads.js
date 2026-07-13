import { processMessage } from '../src/pipeline/index.js';
import dotenv from 'dotenv';
dotenv.config();

const sampleLeads = [
  {
    source_type: 'group',
    source_id: '1234567890@g.us',
    source_name: 'Nairobi Property Seekers',
    sender_number: '254700000001',
    sender_name: 'John Doe',
    raw_message: 'Natafuta chumba Kilimani, 1 bedroom for 3 days starting tomorrow. Budget is 5000 KES per night.'
  },
  {
    source_type: 'dm',
    source_id: '254700000002@s.whatsapp.net',
    source_name: 'Direct Message',
    sender_number: '254700000002',
    sender_name: 'Jane Smith',
    raw_message: 'Hi, do you have any available studios in Westlands for this weekend? It will just be me. Need good WiFi.'
  },
  {
    source_type: 'group',
    source_id: '0987654321@g.us',
    source_name: 'Mombasa Vacation Rentals',
    sender_number: '254700000003',
    sender_name: 'Ali',
    raw_message: 'Good morning everyone, looking for a 2 bedroom apartment in Nyali for next month, 1st to 5th. We are 4 people.'
  },
  {
    source_type: 'group',
    source_id: '1122334455@g.us',
    source_name: 'Random Chat',
    sender_number: '254700000004',
    sender_name: 'Peter',
    raw_message: 'Did anyone watch the game last night? Arsenal played really well!'
  }
];

const runTests = async () => {
  console.log('--- Starting Sample Leads Test ---');
  for (const [index, lead] of sampleLeads.entries()) {
    console.log(`\nProcessing Lead ${index + 1}: ${lead.sender_name}`);
    await processMessage(lead);
    // Add a small delay between processing to avoid overwhelming APIs if they are real
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  console.log('\n--- Finished Sample Leads Test ---');
};

runTests();
