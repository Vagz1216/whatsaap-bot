import crypto from 'crypto';

const SECRET_PREFIX = 'enc:v1:';

const encryptionKeyMaterial = () =>
  process.env.SECRET_ENCRYPTION_KEY ||
  process.env.BYOK_ENCRYPTION_KEY ||
  process.env.DASHBOARD_TOKEN ||
  process.env.DATABASE_URL ||
  '';

const keyFromMaterial = (material) => crypto.createHash('sha256').update(material).digest();

export const encryptSecret = (value) => {
  const plaintext = String(value || '');
  if (!plaintext) return plaintext;
  if (plaintext.startsWith(SECRET_PREFIX)) return plaintext;

  const material = encryptionKeyMaterial();
  if (!material) return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromMaterial(material), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
};

export const decryptSecret = (value) => {
  const stored = String(value || '');
  if (!stored.startsWith(SECRET_PREFIX)) return stored;

  const material = encryptionKeyMaterial();
  if (!material) {
    throw new Error('SECRET_ENCRYPTION_KEY or compatible secret is required to decrypt stored credentials.');
  }

  const payload = Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromMaterial(material), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

export const secretFingerprint = (value) => {
  const secret = String(value || '');
  if (!secret) return { present: false, sha12: null };
  return {
    present: true,
    sha12: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12)
  };
};
