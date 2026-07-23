import dotenv from 'dotenv';

dotenv.config({ override: true });

process.env.TZ = process.env.TZ || 'Africa/Nairobi';
