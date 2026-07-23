import { OpenAI } from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const makeClient = (options = {}) => {
  const apiKey = options.api_key || process.env.AZURE_OPENAI_API_KEY;
  const endpoint = options.azure_endpoint || process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = options.azure_deployment || options.model || process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = options.azure_api_version || process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
  if (!apiKey || !endpoint || !deployment) return null;
  return {
    deployment,
    client: new OpenAI({
      apiKey,
      baseURL: `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': apiKey }
    })
  };
};

export const callAzureOpenAI = async (prompt, systemPrompt, isJson = false, model = null, credential = {}) => {
  const resolved = makeClient({ ...credential, model });
  if (!resolved) throw new Error("Azure OpenAI not configured");

  const response = await resolved.client.chat.completions.create({
    model: resolved.deployment,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    response_format: isJson ? { type: 'json_object' } : undefined,
    temperature: 0.3,
  });

  const text = response.choices[0].message.content;
  if (credential.__return_metadata) {
    return {
      text,
      model: resolved.deployment,
      usage: response.usage || null,
      raw: response
    };
  }
  return text;
};
