import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

export const hasTenantWooCommerceConfig = (tenantConfig = null) => Boolean(
  tenantConfig?.wc_base_url &&
  tenantConfig?.wc_consumer_key_secret &&
  tenantConfig?.wc_consumer_secret_secret
);

const withAuth = (url, tenantConfig = null) => {
  const isSaaS = tenantConfig !== null;
  if (isSaaS && !hasTenantWooCommerceConfig(tenantConfig)) {
    throw new Error('Tenant WooCommerce credentials are not configured.');
  }

  const key = isSaaS ? tenantConfig.wc_consumer_key_secret : process.env.WC_CONSUMER_KEY;
  const secret = isSaaS ? tenantConfig.wc_consumer_secret_secret : process.env.WC_CONSUMER_SECRET;

  if (!key || !secret) return url; // Let it fail cleanly if no keys

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}consumer_key=${encodeURIComponent(key)}&consumer_secret=${encodeURIComponent(secret)}`;
};

const getBaseUrl = (tenantConfig = null) => {
  const isSaaS = tenantConfig !== null;
  if (isSaaS && !hasTenantWooCommerceConfig(tenantConfig)) {
    throw new Error('Tenant WooCommerce credentials are not configured.');
  }
  return isSaaS ? tenantConfig.wc_base_url : (process.env.WC_BASE_URL || 'https://stayez.co.ke');
}

export const searchProperties = async (criteria, tenantConfig = null) => {
  const baseUrl = getBaseUrl(tenantConfig);
  const url = withAuth(`${baseUrl}/wp-json/stayez/v1/filter-bookings`, tenantConfig);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(criteria)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to search properties: ${response.statusText} - ${errorText}`);
  }
  return response.json();
};

export const getVendors = async (tenantConfig = null) => {
  const url = withAuth(`${getBaseUrl(tenantConfig)}/wp-json/dokan/v1/stores?per_page=100`, tenantConfig);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to get vendors: ${response.statusText}`);
  }
  return response.json();
};

export const getVendor = async (vendorId, tenantConfig = null) => {
  const url = withAuth(`${getBaseUrl(tenantConfig)}/wp-json/dokan/v1/stores/${vendorId}`, tenantConfig);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to get vendor ${vendorId}: ${response.statusText}`);
  }
  return response.json();
};

export const createOrder = async (orderData, tenantConfig = null) => {
  const url = withAuth(`${getBaseUrl(tenantConfig)}/wp-json/wc/v3/orders`, tenantConfig);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(orderData)
  });
  
  if (!response.ok) {
    throw new Error(`Failed to create order: ${response.statusText}`);
  }
  return response.json();
};
