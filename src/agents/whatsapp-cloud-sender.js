import fetch from 'node-fetch';

const graphApiVersion = () => process.env.META_GRAPH_API_VERSION || 'v20.0';

export async function sendWhatsAppCloudText({
  phoneNumberId,
  accessToken,
  recipient,
  messageText
}) {
  if (!phoneNumberId || !accessToken || !recipient || !messageText) {
    throw new Error('phoneNumberId, accessToken, recipient, and messageText are required.');
  }

  const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(recipient).replace(/^\+/, ''),
      type: 'text',
      text: {
        preview_url: false,
        body: messageText
      }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `WhatsApp Cloud send failed: ${response.status}`);
  }
  return body;
}
