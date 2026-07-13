import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));

const logger = pino({ level: 'silent' });

export const startMonitor = async (tenantConfigOrCb, cbIfTenant) => {
  // Handle dual-mode arguments
  const isSaaS = typeof tenantConfigOrCb === 'object' && tenantConfigOrCb !== null;
  const tenantConfig = isSaaS ? tenantConfigOrCb : null;
  const onMessageReceived = isSaaS ? cbIfTenant : tenantConfigOrCb;
  
  const tenantName = isSaaS ? tenantConfig.organization_name : 'Local StayEZ';
  
  // Create an isolated auth directory for this specific tenant, or default for local
  const authPath = isSaaS 
    ? path.join(dataDir, `wa-auth-${tenantConfig.wa_session_id}`) 
    : path.join(dataDir, 'wa-auth');

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log(`[Tenant: ${tenantName}] Scan this QR code to authenticate:`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      console.error(`[Tenant: ${tenantName}] WhatsApp connection closed. Full error details:`, JSON.stringify(lastDisconnect?.error, null, 2));
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[Tenant: ${tenantName}] WhatsApp connection closed. Reconnecting:`, shouldReconnect);
      if (shouldReconnect) {
        startMonitor(tenantConfigOrCb, cbIfTenant);
      }
    } else if (connection === 'open') {
      console.log(`[Tenant: ${tenantName}] WhatsApp connection opened. Monitoring messages...`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (text.length < 15) return; // Ignore very short messages

      const isGroup = msg.key.remoteJid.endsWith('@g.us');
      const senderId = isGroup ? msg.key.participant : msg.key.remoteJid;
      
      const isLid = senderId && senderId.endsWith('@lid');
      
      let cleanNumber = senderId ? senderId.split('@')[0] : '';
      if (cleanNumber.includes(':')) {
        cleanNumber = cleanNumber.split(':')[0];
      }
      
      const senderNumber = isLid ? `Hidden-ID-${cleanNumber}` : '+' + cleanNumber;
      
      const sourceId = msg.key.remoteJid;

      // Only read-only operations here. Pass tenantConfig down to the pipeline.
      await onMessageReceived({
        source_type: isGroup ? 'group' : 'dm',
        source_id: sourceId,
        source_name: isGroup ? 'WhatsApp Group' : 'Direct Message',
        sender_number: senderNumber,
        sender_name: msg.pushName || 'Unknown',
        raw_message: text
      }, tenantConfig);
    } catch (err) {
      console.error(`[Tenant: ${tenantName}] Error processing message:`, err);
    }
  });
};
