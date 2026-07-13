import db from '../src/db/index.js';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const addHost = async () => {
  console.log('--- Add Local Host to Cache ---');
  const name = await question('Name: ');
  const whatsapp_number = await question('WhatsApp Number (e.g. 254712345678): ');
  const region = await question('Region (e.g. Nairobi): ');
  const sub_area = await question('Sub Area (e.g. Kilimani): ');
  const unit_types = await question('Unit Types (e.g. studio,1BR): ');
  const price_min = await question('Price Min (KES): ');
  const price_max = await question('Price Max (KES): ');
  const notes = await question('Notes: ');

  try {
    const stmt = db.prepare(`
      INSERT INTO local_hosts (
        name, whatsapp_number, region, sub_area, unit_types, price_min, price_max, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      name, whatsapp_number, region, sub_area, unit_types, 
      price_min ? parseInt(price_min, 10) : null, 
      price_max ? parseInt(price_max, 10) : null, 
      notes
    );

    console.log(`\nSuccessfully added host: ${name} (${whatsapp_number})`);
  } catch (error) {
    console.error('\nFailed to add host:', error.message);
  } finally {
    rl.close();
  }
};

addHost();
