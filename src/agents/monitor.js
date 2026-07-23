import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import qrcode from 'qrcode-terminal';
import { upsertChannelRuntime } from '../db/channel-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));

const logger = pino({ level: 'silent' });
const groupNameCache = new Map();
const whatsappSessionStatus = new Map();
const workerId = process.env.WHATSAPP_WORKER_ID || process.env.HOSTNAME || 'default-worker';

const whatsappBrowserIdentity = () => [
  process.env.WHATSAPP_BROWSER_NAME || 'Scout Ops',
  process.env.WHATSAPP_BROWSER_PLATFORM || 'Chrome',
  process.env.WHATSAPP_BROWSER_VERSION || '124.0.0'
];

const setWhatsAppSessionStatus = (sessionId, patch) => {
  if (!sessionId) return;
  const previous = whatsappSessionStatus.get(sessionId) || {};
  const next = {
    session_id: sessionId,
    status: 'starting',
    worker_id: workerId,
    ...previous,
    ...patch,
    updated_at: new Date().toISOString()
  };
  whatsappSessionStatus.set(sessionId, next);

  if (next.organization_id) {
    upsertChannelRuntime({
      organizationId: next.organization_id,
      channelType: 'whatsapp_web',
      channelKey: sessionId,
      status: next.status,
      workerId: next.worker_id,
      lastError: next.last_error || null,
      metadata: {
        session_id: sessionId,
        tenant: next.tenant || null,
        last_qr_at: next.last_qr_at || null,
        qr_data_url: next.qr_data_url || null,
        connected_at: next.connected_at || null,
        last_message_at: next.last_message_at || null,
        should_reconnect: next.should_reconnect ?? null,
        last_disconnect_code: next.last_disconnect_code || null
      }
    }).catch((error) => {
      console.error(`[Tenant: ${next.tenant || sessionId}] Could not persist WhatsApp runtime status:`, error.message);
    });
  }
};

const qrToSvgDataUrl = (input) => {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZone = 4;
  const cellSize = 8;
  const size = (moduleCount + quietZone * 2) * cellSize;
  const rects = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.isDark(row, col)) {
        rects.push(`<rect x="${(col + quietZone) * cellSize}" y="${(row + quietZone) * cellSize}" width="${cellSize}" height="${cellSize}"/>`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/><g fill="#111820">${rects.join('')}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

export const getWhatsAppSessionStatus = (sessionId, { includeQr = false } = {}) => {
  const status = whatsappSessionStatus.get(sessionId) || {
    session_id: sessionId || null,
    status: sessionId ? 'not_started' : 'not_configured',
    updated_at: null
  };
  const { auth_path, qr_data_url, ...publicStatus } = status;
  if (includeQr && status.status === 'qr_required' && qr_data_url) {
    publicStatus.qr_data_url = qr_data_url;
  }
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
    browser: whatsappBrowserIdentity()
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      setWhatsAppSessionStatus(sessionId, {
        status: 'qr_required',
        last_qr_at: new Date().toISOString(),
        qr_data_url: qrToSvgDataUrl(qr),
        last_error: null
      });
      console.log(`[Tenant: ${tenantName}] Scan this QR code to authenticate:`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.error(`[Tenant: ${tenantName}] WhatsApp connection closed. Status Code:`, statusCode);
      
      // Stop reconnecting for states that require operator action.
      const shouldReconnect = ![
        DisconnectReason.loggedOut,
        DisconnectReason.connectionReplaced,
        408
      ].includes(statusCode);
      const status =
        statusCode === DisconnectReason.loggedOut ? 'logged_out' :
        statusCode === DisconnectReason.connectionReplaced ? 'connection_replaced' :
        statusCode === 408 ? 'qr_timeout' :
        'disconnected';
      
      console.log(`[Tenant: ${tenantName}] WhatsApp connection closed. Reconnecting:`, shouldReconnect);
      setWhatsAppSessionStatus(sessionId, {
        status,
        should_reconnect: shouldReconnect,
        last_disconnect_code: statusCode || null,
        qr_data_url: null,
        last_error: lastDisconnect?.error?.message || null
      });
      if (shouldReconnect) {
        // Add a 5 second delay to avoid hammering the servers on other transient errors
        setTimeout(() => startMonitor(tenantConfigOrCb, cbIfTenant), 5000);
      } else if (statusCode === 408) {
        console.log(`[Tenant: ${tenantName}] QR Code generation timed out. Please restart the server when you are ready to scan.`);
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        console.log(`[Tenant: ${tenantName}] WhatsApp connection was replaced by another active session. Stop the other worker/session before restarting this one.`);
      }
    } else if (connection === 'open') {
      setWhatsAppSessionStatus(sessionId, {
        status: 'connected',
        connected_at: new Date().toISOString(),
        qr_data_url: null,
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
