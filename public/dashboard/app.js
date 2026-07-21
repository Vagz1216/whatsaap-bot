const state = {
  view: 'admin',
  admin: null,
  tenant: null,
  plans: [],
  members: [],
  credentials: [],
  llmPolicy: null,
  events: [],
  organizations: [],
  actor: null,
  auth: {
    clerk: null,
    clerkConfigured: false,
    clerkLoaded: false,
    refreshingFromClerk: false,
    blocked: false
  },
  selectedTenantId: localStorage.getItem('stayez:selectedTenantId') || '0',
  token: localStorage.getItem('stayez:dashboardToken') || '',
  statusFilter: 'all'
};

const routeByView = {
  admin: '/admin',
  tenant: '/tenant',
  leads: '/tenant/leads',
  settings: '/tenant/settings',
  plans: '/plans',
  usage: '/usage',
  organization: '/organization',
  llm: '/llm-credentials',
  compliance: '/compliance'
};

const viewByPath = {
  '/admin': 'admin',
  '/tenant': 'tenant',
  '/tenant/leads': 'leads',
  '/tenant/settings': 'settings',
  '/plans': 'plans',
  '/usage': 'usage',
  '/organization': 'organization',
  '/llm-credentials': 'llm',
  '/compliance': 'compliance'
};

state.view = viewByPath[location.pathname] || (location.pathname.includes('tenant') ? 'tenant' : 'admin');

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const fmt = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const providerUi = {
  openrouter: {
    label: 'OpenRouter',
    keyName: 'OPENROUTER_API_KEY',
    modelHint: 'openrouter/auto, anthropic/claude-sonnet-4.6, or a routed model',
    showBaseUrl: true
  },
  groq: {
    label: 'Groq',
    keyName: 'GROQ_API_KEY',
    modelHint: 'llama-3.3-70b-versatile',
    showBaseUrl: false
  },
  gemini: {
    label: 'Google Gemini',
    keyName: 'GEMINI_API_KEY',
    modelHint: 'gemini-2.5-flash',
    showBaseUrl: false
  },
  azure_openai: {
    label: 'Azure OpenAI',
    keyName: 'AZURE_OPENAI_API_KEY',
    modelHint: 'Azure deployment name',
    showAzure: true
  },
  openai: {
    label: 'OpenAI',
    keyName: 'OPENAI_API_KEY',
    modelHint: 'gpt-4o-mini, gpt-4.1-mini, or your preferred OpenAI model',
    showBaseUrl: true
  },
  cerebras: {
    label: 'Cerebras',
    keyName: 'CEREBRAS_API_KEY',
    modelHint: 'gpt-oss-120b',
    showBaseUrl: true
  }
};

const getAuthToken = async () => {
  if (state.auth.clerk?.session) {
    const token = await state.auth.clerk.session.getToken();
    if (token) return token;
  }
  return state.token;
};

const authHeaders = async () => {
  const token = await getAuthToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
};

const showToast = (message) => {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2600);
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { ...(await authHeaders()), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
};

const showAuthGate = (message = 'Sign in to continue.') => {
  $('#authGate')?.classList.remove('hidden');
  $('.app-shell')?.classList.add('hidden');
  const authMessage = $('#authMessage');
  if (authMessage) authMessage.textContent = message;
};

const hideAuthGate = () => {
  $('#authGate')?.classList.add('hidden');
  $('.app-shell')?.classList.remove('hidden');
};

const loadClerkScript = (publishableKey) => new Promise((resolve, reject) => {
  if (window.Clerk) {
    resolve(window.Clerk);
    return;
  }
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.setAttribute('data-clerk-publishable-key', publishableKey);
  script.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js';
  script.addEventListener('load', () => resolve(window.Clerk));
  script.addEventListener('error', () => reject(new Error('Could not load Clerk sign-in.')));
  document.head.appendChild(script);
});

const renderClerkAuth = async (clerk) => {
  const signInNode = $('#clerkSignIn');
  const userButtonNode = $('#clerkUserButton');

  if (!clerk?.user || !clerk?.session) {
    showAuthGate('Sign in with Clerk to continue.');
    if (signInNode) {
      signInNode.innerHTML = '';
      clerk.mountSignIn(signInNode, {
        routing: 'hash',
        afterSignInUrl: window.location.href,
        afterSignUpUrl: window.location.href
      });
    }
    if (userButtonNode) userButtonNode.innerHTML = '';
    return;
  }

  hideAuthGate();
  if (signInNode) {
    try {
      clerk.unmountSignIn(signInNode);
    } catch {
      signInNode.innerHTML = '';
    }
  }
  if (userButtonNode && !userButtonNode.hasChildNodes()) {
    clerk.mountUserButton(userButtonNode);
  }
};

const initAuth = async () => {
  const response = await fetch('/api/auth/config', { headers: { 'Accept': 'application/json' } });
  const config = response.ok ? await response.json() : {};
  state.auth.clerkConfigured = Boolean(config.clerk_enabled && config.clerk_publishable_key);
  state.auth.blocked = false;
  $('#tokenButton')?.classList.toggle('hidden', Boolean(config.clerk_enabled));
  $('#legacyAuthButton')?.classList.toggle('hidden', Boolean(config.clerk_enabled));

  if (config.clerk_enabled && !config.clerk_publishable_key) {
    state.auth.blocked = true;
    showAuthGate('CLERK_PUBLISHABLE_KEY is missing from the backend environment.');
    return;
  }

  if (!config.clerk_enabled) {
    if (!state.token) showAuthGate('Paste a dashboard token to continue.');
    return;
  }

  showAuthGate('Loading Clerk sign-in...');
  const clerk = await loadClerkScript(config.clerk_publishable_key);
  await clerk.load();
  state.auth.clerk = clerk;
  state.auth.clerkLoaded = true;

  clerk.addListener(async ({ user, session }) => {
    state.auth.clerk = clerk;
    if (!user || !session) {
      state.actor = null;
      showAuthGate('Sign in with Clerk to continue.');
      return;
    }
    await renderClerkAuth(clerk);
    if (!state.auth.refreshingFromClerk) {
      state.auth.refreshingFromClerk = true;
      try {
        await refresh();
      } finally {
        state.auth.refreshingFromClerk = false;
      }
    }
  });

  await renderClerkAuth(clerk);
};

const formData = (form) => Object.fromEntries(new FormData(form).entries());

const splitCsv = (value) => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const safeText = (value) => value == null || value === '' ? 'Not set' : String(value);

const metricCard = (label, value, detail) => `
  <article class="metric-card">
    <div class="metric-accent"></div>
    <small>${label}</small>
    <span class="metric-value">${value}</span>
    <span>${detail}</span>
  </article>
`;

const status = (value) => `<span class="status ${safeText(value)}">${safeText(value)}</span>`;

const selectedOrganization = () => state.organizations.find((org) => String(org.id) === String(state.selectedTenantId)) || state.organizations[0] || null;

const selectedCapabilities = () => selectedOrganization()?.capabilities || {};

const can = (capability) => Boolean(
  state.actor?.system_owner ||
  selectedCapabilities()[capability] ||
  state.actor?.capabilities?.[capability]
);

const canAccessView = (view) => ({
  admin: Boolean(state.actor?.system_owner),
  tenant: can('can_view_tenant'),
  leads: can('can_review_leads'),
  settings: can('can_manage_config'),
  plans: can('can_manage_subscription_plans') || can('can_choose_subscription_plan'),
  usage: can('can_view_tenant'),
  organization: can('can_manage_organization') || can('can_manage_users') || can('can_create_organizations'),
  llm: can('can_manage_llm_credentials'),
  compliance: can('can_view_compliance')
}[view] || false);

const firstAllowedView = () => {
  if (state.actor?.system_owner && canAccessView('admin')) return 'admin';
  return ['tenant', 'leads', 'settings', 'plans', 'usage', 'organization', 'llm', 'compliance', 'admin'].find(canAccessView) || 'tenant';
};

const renderShellAccess = () => {
  $$('.nav-item').forEach((button) => {
    const allowed = canAccessView(button.dataset.view);
    button.classList.toggle('hidden', !allowed);
  });
  $('#tenantSelect').classList.toggle('hidden', state.organizations.length === 0);
  $('#adminView').classList.toggle('hidden', !canAccessView('admin'));
  $('#settingsView').classList.toggle('hidden', !canAccessView('settings'));
};

const setView = (view) => {
  state.view = canAccessView(view) ? view : firstAllowedView();
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  $$('.view').forEach((section) => section.classList.remove('active'));
  $(`#${state.view}View`)?.classList.add('active');
  $('#pageTitle').textContent = {
    admin: 'Admin control',
    tenant: 'Tenant workspace',
    leads: 'Lead review',
    settings: 'Configuration',
    plans: 'Plans',
    usage: 'Usage',
    organization: 'Organization',
    llm: 'LLM keys',
    compliance: 'Compliance'
  }[state.view] || 'Dashboard';
  history.pushState(null, '', routeByView[state.view] || '/tenant');
};

const renderTenantSelect = () => {
  const select = $('#tenantSelect');
  select.innerHTML = state.organizations
    .map((org) => `<option value="${org.id}">${org.name}</option>`)
    .join('');
  if (state.organizations.some((org) => String(org.id) === String(state.selectedTenantId))) {
    select.value = state.selectedTenantId;
  } else if (state.organizations[0]) {
    state.selectedTenantId = String(state.organizations[0].id);
    select.value = state.selectedTenantId;
  }
  $('#contactOrganizationId').value = state.selectedTenantId;
};

const renderAdmin = () => {
  const data = state.admin;
  if (!data || !state.actor?.system_owner) return;

  $('#modeLabel').textContent = data.mode === 'saas' ? 'SaaS mode' : 'Local mode';
  $('#healthLabel').textContent = `${fmt.format(data.leads.total_leads || 0)} leads tracked`;

  $('#adminMetrics').innerHTML = [
    metricCard('Organizations', fmt.format(data.organizations.total || 0), `${fmt.format(data.organizations.active || 0)} active tenants`),
    metricCard('Lead volume', fmt.format(data.leads.total_leads || 0), `${fmt.format(data.leads.ready_leads || 0)} ready or delivered`),
    metricCard('Contacts', fmt.format(data.contacts.total_contacts || 0), 'Manual matching inventory'),
    metricCard('30 day LLM cost', money.format(Number(data.usage.llm_cost_usd || 0)), `${fmt.format(data.usage.llm_tokens || 0)} tokens`)
  ].join('');

  $('#organizationsTable').innerHTML = data.organizations_table.map((org) => `
    <tr>
      <td><strong>${org.name}</strong><br><small>${org.slug}</small></td>
      <td>${status(org.status)}</td>
      <td>${safeText(org.plan_name)}</td>
      <td>${fmt.format(org.lead_count || 0)}</td>
      <td><button class="ghost-button" data-manage-plan="${org.id}" type="button">Manage plan</button></td>
    </tr>
  `).join('') || '<tr><td colspan="5">No organizations yet.</td></tr>';
};

const leadCard = (lead, compact = false) => {
  const extracted = lead.extracted_data || {};
  const message = safeText(lead.raw_message).slice(0, compact ? 140 : 220);
  return `
    <article class="lead-card" data-lead-id="${lead.id}">
      <div class="lead-card-header">
        <div>
          <strong>${safeText(lead.sender_name)}</strong>
          <small>${safeText(lead.source_platform)} / ${safeText(lead.source_channel || lead.source_type)}</small>
        </div>
        ${status(lead.status)}
      </div>
      <p>${message}${lead.raw_message && lead.raw_message.length > message.length ? '...' : ''}</p>
      <div class="data-box">
        ${safeText(extracted.location)} | ${safeText(extracted.check_in)} | ${safeText(extracted.budget)}
      </div>
      <div class="lead-card-footer">
        <small>${Math.round((lead.classifier_confidence || 0) * 100)}% confidence</small>
        <button class="ghost-button" data-open-lead="${lead.id}" type="button">Review</button>
      </div>
    </article>
  `;
};

const renderTenant = () => {
  const data = state.tenant;
  if (!data) return;

  $('#tenantMetrics').innerHTML = [
    metricCard('Tenant', data.organization.name, status(data.organization.status)),
    metricCard('Leads', fmt.format(data.stats.total_leads || 0), `${fmt.format(data.stats.ready_leads || 0)} ready or delivered`),
    metricCard('Manual replies', fmt.format(data.stats.manual_required || 0), 'Platform or group handoff'),
    metricCard('Contacts', fmt.format(data.stats.contacts || 0), 'Available for matching')
  ].join('');

  $('#tenantLeadList').innerHTML = data.leads.slice(0, 12).map((lead) => leadCard(lead, true)).join('') || '<p>No leads captured yet.</p>';
  $('#contactsList').innerHTML = data.contacts.slice(0, 8).map((contact) => `
    <div class="contact-row">
      <div>
        <strong>${contact.name}</strong>
        <small>${safeText(contact.region)} / ${safeText(contact.sub_area)}</small>
      </div>
      <span>${contact.whatsapp_number}</span>
    </div>
  `).join('') || '<p>No contacts yet.</p>';

  const config = data.config || {};
  const configForm = $('#configForm');
  if (configForm && canAccessView('settings')) {
    configForm.llm_routing_mode.value = config.llm_routing_mode || 'balanced';
    configForm.default_language.value = config.default_language || 'en';
    configForm.wc_base_url.value = config.wc_base_url || '';
    configForm.wc_consumer_key_secret.placeholder = config.wc_consumer_key_configured ? 'Configured - leave blank to keep current key' : 'Not configured';
    configForm.wc_consumer_secret_secret.placeholder = config.wc_consumer_secret_configured ? 'Configured - leave blank to keep current secret' : 'Not configured';
    configForm.meta_access_token_secret.placeholder = config.meta_access_token_configured ? 'Configured - leave blank to keep current token' : 'Not configured';
    configForm.keyword_whitelist.value = (config.keyword_whitelist || []).join(', ');
    configForm.keyword_blacklist.value = (config.keyword_blacklist || []).join(', ');
    configForm.drafter_persona.value = config.drafter_persona || '';
  }

  renderLeads();
  renderUsage();
  renderUsageDetail();
};

const renderLeads = () => {
  const leads = state.tenant?.leads || [];
  const visible = state.statusFilter === 'all'
    ? leads
    : leads.filter((lead) => lead.status === state.statusFilter);
  $('#leadBoard').innerHTML = visible.map((lead) => leadCard(lead)).join('') || '<p>No leads match this filter.</p>';
};

const renderUsage = () => {
  const usage = state.tenant?.usage || {};
  const tokenValue = Math.min(100, Math.round((Number(usage.llm_tokens || 0) / 100000) * 100));
  const fallbackValue = Math.min(100, Number(usage.requests || 0) ? Math.round((Number(usage.fallback_count || 0) / Number(usage.requests)) * 100) : 0);
  $('#usagePanel').innerHTML = `
    <div class="usage-row"><strong>AI credits</strong><span>${fmt.format(usage.ai_credits || 0)}</span></div>
    <div class="usage-row"><strong>LLM cost</strong><span>${money.format(Number(usage.llm_cost_usd || 0))}</span></div>
    <div class="usage-row"><strong>Requests</strong><span>${fmt.format(usage.requests || 0)}</span></div>
    <div class="usage-row"><strong>Average latency</strong><span>${Math.round(usage.avg_latency_ms || 0)} ms</span></div>
    <div>
      <div class="lead-card-footer"><small>Token pressure</small><small>${fmt.format(usage.llm_tokens || 0)} tokens</small></div>
      <div class="bar"><span style="--value: ${tokenValue}%"></span></div>
    </div>
    <div>
      <div class="lead-card-footer"><small>Fallback rate</small><small>${fallbackValue}%</small></div>
      <div class="bar"><span style="--value: ${fallbackValue}%"></span></div>
    </div>
  `;
};

const renderUsageDetail = () => {
  const usage = state.tenant?.usage || {};
  $('#usageMetrics').innerHTML = [
    metricCard('AI credits', fmt.format(usage.ai_credits || 0), 'Metered customer-facing actions'),
    metricCard('LLM cost', money.format(Number(usage.llm_cost_usd || 0)), 'Estimated provider spend'),
    metricCard('Requests', fmt.format(usage.requests || 0), 'LLM request count'),
    metricCard('Fallback rate', `${Number(usage.requests || 0) ? Math.round((Number(usage.fallback_count || 0) / Number(usage.requests)) * 100) : 0}%`, 'Provider reliability signal')
  ].join('');
  $('#usageDetailPanel').innerHTML = `
    <div class="usage-row"><strong>Total tokens</strong><span>${fmt.format(usage.llm_tokens || 0)}</span></div>
    <div class="usage-row"><strong>Average latency</strong><span>${Math.round(usage.avg_latency_ms || 0)} ms</span></div>
    <div class="usage-row"><strong>Fallback count</strong><span>${fmt.format(usage.fallback_count || 0)}</span></div>
    <div class="usage-row"><strong>Active plan</strong><span>${safeText(selectedOrganization()?.subscription?.plan?.name)}</span></div>
  `;
};

const renderPlans = () => {
  const newTenantPlanSelect = $('#newTenantPlanSelect');
  if (newTenantPlanSelect) {
    newTenantPlanSelect.innerHTML = '<option value="">Select plan</option>' + state.plans
      .filter((plan) => plan.active)
      .map((plan) => `<option value="${plan.id}">${plan.name} - ${money.format(Number(plan.monthly_price_cents || 0) / 100)}</option>`)
      .join('');
  }
  $('#plansTable').innerHTML = state.plans.map((plan) => `
    <tr>
      <td><strong>${safeText(plan.name)}</strong><br><small>${safeText(plan.slug)}</small></td>
      <td>${money.format(Number(plan.monthly_price_cents || 0) / 100)} ${safeText(plan.currency_code || 'USD')}</td>
      <td>${plan.max_monthly_ai_credits ? fmt.format(plan.max_monthly_ai_credits) : 'Unlimited'}</td>
      <td>${safeText((plan.allowed_llm_routing_modes || []).join(', '))}</td>
      <td>${status(plan.active ? 'ACTIVE' : 'ARCHIVED')}</td>
      <td>
        ${can('can_choose_subscription_plan') && selectedOrganization()?.id
          ? `<button class="ghost-button" data-assign-plan="${plan.id}" type="button">Assign</button>`
          : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6">No plans configured.</td></tr>';
};

const renderOrganization = () => {
  const org = selectedOrganization();
  const form = $('#organizationEditForm');
  if (!org || !form) return;
  form.name.value = org.name || '';
  form.slug.value = org.slug || '';
  form.timezone.value = org.timezone || 'Africa/Nairobi';
  form.status.value = org.status || 'ACTIVE';
  $('#organizationPlanSelect').innerHTML = state.plans
    .map((plan) => `<option value="${plan.id}">${plan.name} - ${money.format(Number(plan.monthly_price_cents || 0) / 100)}</option>`)
    .join('');
  if (org.subscription?.plan?.id) {
    $('#organizationPlanSelect').value = String(org.subscription.plan.id);
  }
  $('#membersList').innerHTML = state.members.map((member) => `
    <div class="contact-row">
      <div>
        <strong>${safeText(member.email)}</strong>
        <small>${safeText(member.name)} / ${safeText(member.role)}</small>
      </div>
      ${status(member.status)}
    </div>
  `).join('') || '<p>No members configured.</p>';
};

const renderLlmCredentials = () => {
  const policy = state.llmPolicy;
  $('#llmPolicyPanel').innerHTML = policy ? `
    <div class="contact-row">
      <div>
        <strong>${policy.enabled ? 'BYOK enabled' : 'BYOK disabled'}</strong>
        <small>${safeText(policy.provider_mode || 'platform_first')} / max ${policy.max_credentials ?? 'unlimited'} keys</small>
      </div>
      ${status(policy.plan_allows_byok ? 'PLAN ALLOWS' : 'PLAN BLOCKS')}
    </div>
  ` : '';
  $('#llmCredentialsList').innerHTML = state.credentials.map((credential) => `
    <div class="contact-row">
      <div>
        <strong>${safeText(credential.label)}</strong>
        <small>${safeText(credential.provider)} / ${safeText(credential.default_model)} / ${safeText(credential.api_key_fingerprint?.sha12 || 'no fingerprint')}</small>
        <small>${credential.last_tested_at ? `Last test: ${credential.last_error ? 'failed' : 'passed'} / ${safeText(credential.last_tested_at)}` : 'Not tested'}</small>
        ${credential.last_error ? `<small>${safeText(credential.last_error)}</small>` : ''}
      </div>
      <div class="topbar-actions">
        ${status(credential.status)}
        <button class="ghost-button" data-test-credential="${credential.id}" type="button">Test</button>
        <button class="ghost-button" data-disable-credential="${credential.id}" type="button">Disable</button>
      </div>
    </div>
  `).join('') || '<p>No organization LLM keys configured.</p>';
};

const setRequired = (selector, required) => {
  const input = $(`${selector} input`);
  if (input) input.required = required;
};

const updateLlmCredentialForm = () => {
  const form = $('#llmCredentialForm');
  if (!form) return;
  const provider = form.provider.value;
  const config = providerUi[provider] || providerUi.openrouter;
  const showAzure = Boolean(config.showAzure);
  const showBaseUrl = Boolean(config.showBaseUrl) && !showAzure;

  $('#llmApiKeyLabel').childNodes[0].textContent = `${config.keyName} `;
  $('#llmCredentialLabel').placeholder = `${config.label} primary`;
  form.default_model.placeholder = config.modelHint;

  $('#llmBaseUrlLabel').classList.toggle('hidden', !showBaseUrl);
  $('#llmAzureEndpointLabel').classList.toggle('hidden', !showAzure);
  $('#llmAzureDeploymentLabel').classList.toggle('hidden', !showAzure);
  $('#llmAzureApiVersionLabel').classList.toggle('hidden', !showAzure);

  setRequired('#llmAzureEndpointLabel', showAzure);
  setRequired('#llmAzureDeploymentLabel', showAzure);
  if (!showBaseUrl) form.base_url.value = '';
  if (!showAzure) {
    form.azure_endpoint.value = '';
    form.azure_deployment.value = '';
    form.azure_api_version.value = '';
  }
};

const renderCompliance = () => {
  $('#complianceTable').innerHTML = state.events.map((event) => `
    <tr>
      <td><strong>${safeText(event.event_type)}</strong></td>
      <td>${safeText(event.organization_name || event.organization_id)}</td>
      <td>${safeText(event.user_email || event.user_id)}</td>
      <td><code>${safeText(JSON.stringify(event.metadata || {})).slice(0, 180)}</code></td>
      <td>${safeText(event.created_at)}</td>
    </tr>
  `).join('') || '<tr><td colspan="5">No compliance events yet.</td></tr>';
};

const openLead = (leadId) => {
  const lead = (state.tenant?.leads || []).find((item) => String(item.id) === String(leadId));
  if (!lead) return;
  $('#dialogTitle').textContent = `${lead.sender_name || 'Unknown'} - ${lead.source_platform}`;
  $('#dialogBody').innerHTML = `
    <div class="dialog-grid">
      <section>
        <h3>Inbound message</h3>
        <div class="draft-box">${safeText(lead.raw_message)}</div>
      </section>
      <section>
        <h3>Extracted data</h3>
        <div class="draft-box">${JSON.stringify(lead.extracted_data || {}, null, 2)}</div>
      </section>
      <section>
        <h3>Client draft</h3>
        <div class="draft-box">${safeText(lead.draft_to_client?.message)}</div>
      </section>
      <section>
        <h3>Source or contact draft</h3>
        <div class="draft-box">${safeText(lead.draft_to_source?.message || lead.drafts_to_contacts?.[0]?.message)}</div>
      </section>
    </div>
    <div class="topbar-actions">
      <button class="primary-button" data-status-action="approved" data-lead-id="${lead.id}" type="button">Mark approved</button>
      <button class="ghost-button" data-status-action="rejected" data-lead-id="${lead.id}" type="button">Reject</button>
      <button class="ghost-button" data-status-action="archived" data-lead-id="${lead.id}" type="button">Archive</button>
    </div>
  `;
  $('#leadDialog').showModal();
};

const loadOrganizations = async () => {
  const body = await api('/api/me');
  state.actor = {
    user: body.user,
    system_owner: Boolean(body.system_owner),
    auth_mode: body.auth_mode,
    capabilities: body.capabilities || {}
  };
  state.organizations = body.organizations || [];
  renderTenantSelect();
  renderShellAccess();
};

const loadManagementData = async () => {
  state.plans = canAccessView('plans') ? (await api('/api/plans')).plans || [] : [];
  const org = selectedOrganization();
  const orgId = org?.id;
  if (!orgId && orgId !== 0) return;

  if (canAccessView('organization') && Number(orgId) > 0) {
    state.members = (await api(`/api/organizations/${orgId}/users`)).users || [];
  } else {
    state.members = [];
  }

  if (canAccessView('llm') && Number(orgId) > 0) {
    const llmData = await api(`/api/organizations/${orgId}/llm-credentials`);
    state.credentials = llmData.credentials || [];
    state.llmPolicy = llmData.policy || null;
  } else {
    state.credentials = [];
    state.llmPolicy = null;
  }

  if (canAccessView('compliance')) {
    const query = Number(orgId) > 0 && !state.actor?.system_owner ? `?organization_id=${orgId}` : '';
    state.events = (await api(`/api/compliance/events${query}`)).events || [];
  } else {
    state.events = [];
  }
};

const refresh = async () => {
  try {
    await loadOrganizations();
    hideAuthGate();
    state.admin = state.actor?.system_owner ? await api('/api/admin/overview') : null;
    if (state.selectedTenantId !== '' && canAccessView('tenant')) {
      state.tenant = await api(`/api/tenants/${state.selectedTenantId}`);
    }
    await loadManagementData();
    renderAdmin();
    renderTenant();
    renderPlans();
    renderOrganization();
    renderLlmCredentials();
    renderCompliance();
    setView(state.view);
  } catch (error) {
    if (['dashboard_token_required', 'authentication_required', 'invalid_or_expired_token'].includes(error.message)) {
      $('#tokenPanel').classList.remove('hidden');
      if (state.auth.clerkConfigured) {
        await renderClerkAuth(state.auth.clerk);
      } else {
        showAuthGate('Authentication is required.');
      }
    }
    showToast(error.message);
  }
};

const submitOrganization = async (event) => {
  event.preventDefault();
  if (!state.actor?.system_owner) return;
  const payload = formData(event.currentTarget);
  payload.plan_id = Number(payload.plan_id);
  await api('/api/admin/organizations', { method: 'POST', body: JSON.stringify(payload) });
  event.currentTarget.reset();
  showToast('Tenant created');
  await refresh();
};

const submitContact = async (event) => {
  event.preventDefault();
  if (!can('can_manage_contacts')) return showToast('Contact management is not allowed for this role');
  const payload = formData(event.currentTarget);
  payload.organization_id = Number(state.selectedTenantId);
  await api('/api/contacts', { method: 'POST', body: JSON.stringify(payload) });
  event.currentTarget.reset();
  $('#contactOrganizationId').value = state.selectedTenantId;
  showToast('Contact saved');
  await refresh();
};

const submitConfig = async (event) => {
  event.preventDefault();
  if (!can('can_manage_config')) return showToast('Configuration is not allowed for this role');
  const payload = formData(event.currentTarget);
  payload.keyword_whitelist = splitCsv(payload.keyword_whitelist);
  payload.keyword_blacklist = splitCsv(payload.keyword_blacklist);
  if (!payload.wc_consumer_key_secret) delete payload.wc_consumer_key_secret;
  if (!payload.wc_consumer_secret_secret) delete payload.wc_consumer_secret_secret;
  if (!payload.meta_access_token_secret) delete payload.meta_access_token_secret;
  await api(`/api/tenants/${state.selectedTenantId}/config`, { method: 'PATCH', body: JSON.stringify(payload) });
  showToast('Configuration updated');
  await refresh();
};

const submitPlan = async (event) => {
  event.preventDefault();
  if (!can('can_manage_subscription_plans')) return showToast('Plan management is not allowed for this role');
  const payload = formData(event.currentTarget);
  payload.monthly_price_cents = Number(payload.monthly_price_cents || 0);
  payload.trial_days = Number(payload.trial_days || 14);
  payload.max_monthly_ai_credits = payload.max_monthly_ai_credits ? Number(payload.max_monthly_ai_credits) : null;
  payload.max_monthly_messages = payload.max_monthly_messages ? Number(payload.max_monthly_messages) : null;
  payload.allow_byok = payload.allow_byok === 'true';
  await api('/api/plans', { method: 'POST', body: JSON.stringify(payload) });
  event.currentTarget.reset();
  showToast('Plan created');
  await refresh();
};

const assignPlan = async (planId) => {
  if (!can('can_choose_subscription_plan')) return showToast('Plan assignment is not allowed for this role');
  await api(`/api/organizations/${state.selectedTenantId}/subscription`, {
    method: 'POST',
    body: JSON.stringify({ plan_id: Number(planId), status: 'ACTIVE' })
  });
  showToast('Plan assigned');
  await refresh();
};

const manageOrganizationPlan = async (organizationId) => {
  state.selectedTenantId = String(organizationId);
  localStorage.setItem('stayez:selectedTenantId', state.selectedTenantId);
  const tenantSelect = $('#tenantSelect');
  if (tenantSelect) tenantSelect.value = state.selectedTenantId;
  $('#contactOrganizationId').value = state.selectedTenantId;
  state.tenant = await api(`/api/tenants/${state.selectedTenantId}`);
  await loadManagementData();
  setView('plans');
  renderTenant();
  renderPlans();
  renderOrganization();
};

const submitOrganizationEdit = async (event) => {
  event.preventDefault();
  if (!can('can_manage_organization')) return showToast('Organization management is not allowed for this role');
  const payload = formData(event.currentTarget);
  const planId = Number(payload.plan_id);
  delete payload.plan_id;
  await api(`/api/organizations/${state.selectedTenantId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  if (planId) {
    await api(`/api/organizations/${state.selectedTenantId}/subscription`, {
      method: 'POST',
      body: JSON.stringify({ plan_id: planId, status: 'ACTIVE' })
    });
  }
  showToast('Organization updated');
  await refresh();
};

const submitMember = async (event) => {
  event.preventDefault();
  if (!can('can_manage_users')) return showToast('User management is not allowed for this role');
  const payload = formData(event.currentTarget);
  await api(`/api/organizations/${state.selectedTenantId}/users`, { method: 'POST', body: JSON.stringify(payload) });
  event.currentTarget.reset();
  showToast('Member saved');
  await refresh();
};

const submitLlmCredential = async (event) => {
  event.preventDefault();
  if (!can('can_manage_llm_credentials')) return showToast('LLM key management is not allowed for this role');
  const payload = formData(event.currentTarget);
  await api(`/api/organizations/${state.selectedTenantId}/llm-credentials`, { method: 'POST', body: JSON.stringify(payload) });
  event.currentTarget.reset();
  showToast('LLM key saved');
  await refresh();
};

const disableCredential = async (credentialId) => {
  if (!can('can_manage_llm_credentials')) return showToast('LLM key management is not allowed for this role');
  await api(`/api/organizations/${state.selectedTenantId}/llm-credentials/${credentialId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'DISABLED' })
  });
  showToast('Credential disabled');
  await refresh();
};

const testCredential = async (credentialId) => {
  if (!can('can_manage_llm_credentials')) return showToast('LLM key management is not allowed for this role');
  const result = await api(`/api/organizations/${state.selectedTenantId}/llm-credentials/${credentialId}/test`, { method: 'POST' });
  showToast(result.message || `Credential test ${result.status}`);
  await refresh();
};

const updateStatus = async (leadId, nextStatus) => {
  if (!can('can_update_lead_status')) return showToast('Lead status updates are not allowed for this role');
  await api(`/api/leads/${leadId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: nextStatus, organization_id: Number(state.selectedTenantId) })
  });
  $('#leadDialog').close();
  showToast(`Lead marked ${nextStatus}`);
  await refresh();
};

const bindEvents = () => {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#refreshButton').addEventListener('click', refresh);
  $('#tenantSelect').addEventListener('change', async (event) => {
    state.selectedTenantId = event.target.value;
    localStorage.setItem('stayez:selectedTenantId', state.selectedTenantId);
    $('#contactOrganizationId').value = state.selectedTenantId;
    state.tenant = await api(`/api/tenants/${state.selectedTenantId}`);
    await loadManagementData();
    renderTenant();
    renderPlans();
    renderOrganization();
    renderLlmCredentials();
    renderCompliance();
  });
  $('#tokenButton').addEventListener('click', () => $('#tokenPanel').classList.toggle('hidden'));
  $('#legacyAuthButton')?.addEventListener('click', () => {
    hideAuthGate();
    $('#tokenPanel').classList.remove('hidden');
  });
  $('#saveTokenButton').addEventListener('click', async () => {
    state.token = $('#dashboardToken').value.trim();
    localStorage.setItem('stayez:dashboardToken', state.token);
    $('#tokenPanel').classList.add('hidden');
    await refresh();
  });
  $('#organizationForm').addEventListener('submit', submitOrganization);
  $('#contactForm').addEventListener('submit', submitContact);
  $('#configForm').addEventListener('submit', submitConfig);
  $('#planForm').addEventListener('submit', submitPlan);
  $('#organizationEditForm').addEventListener('submit', submitOrganizationEdit);
  $('#memberForm').addEventListener('submit', submitMember);
  $('#llmCredentialForm').addEventListener('submit', submitLlmCredential);
  $('#llmProviderSelect').addEventListener('change', updateLlmCredentialForm);
  $('#closeDialogButton').addEventListener('click', () => $('#leadDialog').close());
  $('#statusFilter').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-status]');
    if (!button) return;
    state.statusFilter = button.dataset.status;
    $$('#statusFilter button').forEach((item) => item.classList.toggle('active', item === button));
    renderLeads();
  });
  document.body.addEventListener('click', async (event) => {
    const openButton = event.target.closest('[data-open-lead]');
    if (openButton) {
      openLead(openButton.dataset.openLead);
      return;
    }
    const statusButton = event.target.closest('[data-status-action]');
    if (statusButton) {
      await updateStatus(statusButton.dataset.leadId, statusButton.dataset.statusAction);
      return;
    }
    const assignPlanButton = event.target.closest('[data-assign-plan]');
    if (assignPlanButton) {
      await assignPlan(assignPlanButton.dataset.assignPlan);
      return;
    }
    const managePlanButton = event.target.closest('[data-manage-plan]');
    if (managePlanButton) {
      await manageOrganizationPlan(managePlanButton.dataset.managePlan);
      return;
    }
    const disableCredentialButton = event.target.closest('[data-disable-credential]');
    if (disableCredentialButton) {
      await disableCredential(disableCredentialButton.dataset.disableCredential);
      return;
    }
    const testCredentialButton = event.target.closest('[data-test-credential]');
    if (testCredentialButton) {
      await testCredential(testCredentialButton.dataset.testCredential);
    }
  });
};

const boot = async () => {
  bindEvents();
  updateLlmCredentialForm();
  try {
    await initAuth();
    if (state.auth.blocked) return;
    if (state.auth.clerkConfigured && !state.auth.clerk?.session) return;
    await refresh();
  } catch (error) {
    showAuthGate(error.message || 'Authentication could not be initialized.');
    showToast(error.message || 'Authentication could not be initialized.');
  }
};

boot();
