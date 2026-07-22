import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));

const logger = pino({ level: 'silent' });
const groupNameCache = new Map();
const whatsappSessionStatus = new Map();

const setWhatsAppSessionStatus = (sessionId, patch) => {
  if (!sessionId) return;
  const previous = whatsappSessionStatus.get(sessionId) || {};
  whatsappSessionStatus.set(sessionId, {
    session_id: sessionId,
    status: 'starting',
    ...previous,
    ...patch,
    updated_at: new Date().toISOString()
  });
};

export const getWhatsAppSessionStatus = (sessionId) => {
  const status = whatsappSessionStatus.get(sessionId) || {
    session_id: sessionId || null,
    status: sessionId ? 'not_started' : 'not_configured',
    updated_at: null
  };
  const { auth_path, ...publicStatus } = status;
  return publicStatus;
};

const getGroupName = async (sock, groupJid) => {
  if (!groupJid) return 'WhatsApp Group';
  if (groupNameCache.has(groupJid)) return groupNameCache.get(groupJid);

  try {
    const metadata = await sock.groupMetadata(groupJid);
    const groupName = metadata?.subject || 'WhatsApp Group';
    groupNameCache.set(groupJid, groupName);
    return groupName;
  } catch (error) {
    return 'WhatsApp Group';
  }
};

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
  const sessionId = isSaaS ? tenantConfig.wa_session_id : 'local';
  setWhatsAppSessionStatus(sessionId, {
    organization_id: tenantConfig?.organization_id || null,
    tenant: tenantName,
    auth_path: authPath,
    status: 'starting'
  });

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
      setWhatsAppSessionStatus(sessionId, {
        status: 'qr_required',
        last_qr_at: new Date().toISOString(),
        last_error: null
      });
      console.log(`[Tenant: ${tenantName}] Scan this QR code to authenticate:`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.error(`[Tenant: ${tenantName}] WhatsApp connection closed. Status Code:`, statusCode);
      
      // Stop reconnecting if we get logged out (401) OR if the QR code times out (408)
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 408;
      
      console.log(`[Tenant: ${tenantName}] WhatsApp connection closed. Reconnecting:`, shouldReconnect);
      setWhatsAppSessionStatus(sessionId, {
        status: statusCode === DisconnectReason.loggedOut ? 'logged_out' : statusCode === 408 ? 'qr_timeout' : 'disconnected',
        should_reconnect: shouldReconnect,
        last_disconnect_code: statusCode || null,
        last_error: lastDisconnect?.error?.message || null
      });
      if (shouldReconnect) {
        // Add a 5 second delay to avoid hammering the servers on other transient errors
        setTimeout(() => startMonitor(tenantConfigOrCb, cbIfTenant), 5000);
      } else if (statusCode === 408) {
        console.log(`[Tenant: ${tenantName}] QR Code generation timed out. Please restart the server when you are ready to scan.`);
      }
    } else if (connection === 'open') {
      setWhatsAppSessionStatus(sessionId, {
        status: 'connected',
        connected_at: new Date().toISOString(),
        last_error: null
      });
      console.log(`[Tenant: ${tenantName}] WhatsApp connection opened. Monitoring messages...`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;
      setWhatsAppSessionStatus(sessionId, {
        last_message_at: new Date().toISOString()
      });

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
      const sourceName = isGroup ? await getGroupName(sock, sourceId) : 'Direct Message';

      // Only read-only operations here. Pass tenantConfig down to the pipeline.
      await onMessageReceived({
        source_platform: 'whatsapp',
        source_type: isGroup ? 'group' : 'dm',
        source_channel: isGroup ? 'whatsapp_group' : 'whatsapp_dm',
        source_id: sourceId,
        source_name: sourceName,
        source_group_name: isGroup ? sourceName : null,
        message_id: msg.key.id,
        external_message_id: msg.key.id,
        sender_external_id: senderId,
        sender_jid: senderId,
        sender_number: senderNumber,
        sender_name: msg.pushName || 'Unknown',
        raw_message: text,
        received_at: msg.messageTimestamp
          ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        metadata: {
          remote_jid: msg.key.remoteJid,
          participant_jid: msg.key.participant || null,
          is_lid: isLid
        }
      }, tenantConfig);
    } catch (err) {
      console.error(`[Tenant: ${tenantName}] Error processing message:`, err);
    }
  });
};
