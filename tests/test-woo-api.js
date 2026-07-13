import { searchProperties, getVendors } from '../src/stayez/api.js';

async function testWooCommerce() {
  console.log('Testing WooCommerce API Connection...');
  console.log('Base URL:', process.env.WC_BASE_URL || 'https://stayez.co.ke');
  console.log('Consumer Key starts with:', process.env.WC_CONSUMER_KEY ? process.env.WC_CONSUMER_KEY.substring(0, 7) + '...' : 'MISSING');
  console.log('Consumer Secret starts with:', process.env.WC_CONSUMER_SECRET ? process.env.WC_CONSUMER_SECRET.substring(0, 7) + '...' : 'MISSING');
  
  try {
    console.log('\nAttempting to fetch vendors (Dokan API)...');
    const vendors = await getVendors();
    console.log(`✅ Success! Found ${vendors.length} vendors.`);
    
    console.log('\nAttempting to search properties (Custom StayEZ API)...');
    const criteria = { location: 'test' };
    const properties = await searchProperties(criteria);
    console.log('✅ Success! Search API is responding.');
    
  } catch (error) {
    console.error('\n❌ ERROR OCCURRED:');
    console.error(error.message);
    
    if (error.message.includes('invalid_username')) {
      console.log('\n--- DIAGNOSIS ---');
      console.log('The "invalid_username" error usually happens for one of two reasons:');
      console.log('1. The Consumer Key or Secret in your .env file is incorrect.');
      console.log('2. Your WordPress server is stripping the Authorization headers (very common on shared hosting).');
      console.log('\nCheck your .env file and ensure:');
      console.log('WC_CONSUMER_KEY="ck_..."');
      console.log('WC_CONSUMER_SECRET="cs_..."');
    }
  }
}

testWooCommerce();