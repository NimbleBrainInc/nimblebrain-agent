/**
 * ACP's `providers/*` (the Configurable LLM Providers RFD, unstable): where
 * each provider's model calls go, set by the client over the connection.
 *
 * - The configuration belongs to the connection: each connection has an agent
 *   of its own (`src/serve/http.ts`), so one client's routes never reach
 *   another's. A session takes the routes as they stand when it opens.
 * - `providers/set` replaces the provider's route: its calls go to `baseUrl`
 *   with exactly `headers`, never with the process's own key, and empty headers
 *   send no authorization at all. So a client can point a provider anywhere
 *   without the process's key following it.
 * - `providers/disable` turns a provider off: a session refuses its calls.
 * - `providers/list` never returns headers: they hold credentials.
 * - Nothing is persisted, and nothing here is logged but provider ids.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import {
  PROVIDER_PROTOCOLS,
  PROVIDERS,
  type ProviderRoute,
  processBaseUrl,
} from "../model/resolve.ts";

type Env = Record<string, string | undefined>;

/** One connection's provider configuration: a route, or `null` for disabled. */
export type ProviderRoutes = Map<string, ProviderRoute | null>;

function isProvider(id: string): id is (typeof PROVIDERS)[number] {
  return (PROVIDERS as readonly string[]).includes(id);
}

/** `providers/list`: every provider, its protocol, and where its calls go now. */
export function listProviders(routes: ProviderRoutes, env: Env): acp.ListProvidersResponse {
  return {
    providers: PROVIDERS.map((providerId) => {
      const route = routes.get(providerId);
      const apiType = PROVIDER_PROTOCOLS[providerId];
      const current =
        route === null
          ? null
          : { apiType, baseUrl: route ? route.baseUrl : processBaseUrl(providerId, env) };
      return { providerId, supported: [apiType], required: false, current };
    }),
  };
}

/** `providers/set`: route a provider's calls, refusing an unknown provider or protocol. */
export function setProvider(routes: ProviderRoutes, params: acp.SetProviderRequest): void {
  const { providerId, apiType, baseUrl, headers } = params;
  if (!isProvider(providerId)) {
    throw acp.RequestError.invalidParams(undefined, `unknown provider "${providerId}"`);
  }
  if (apiType !== PROVIDER_PROTOCOLS[providerId]) {
    throw acp.RequestError.invalidParams(
      undefined,
      `provider "${providerId}" speaks ${PROVIDER_PROTOCOLS[providerId]}, not ${apiType}`,
    );
  }
  if (!URL.canParse(baseUrl)) {
    throw acp.RequestError.invalidParams(undefined, `baseUrl for "${providerId}" is not a URL`);
  }
  routes.set(providerId, { baseUrl, headers: { ...(headers ?? {}) } });
}

/** `providers/disable`: turn a provider off. An unknown provider is already off. */
export function disableProvider(routes: ProviderRoutes, params: acp.DisableProviderRequest): void {
  if (isProvider(params.providerId)) routes.set(params.providerId, null);
}

/** The routes a new session takes, or nothing when the client set none. */
export function sessionRoutes(
  routes: ProviderRoutes,
): Record<string, ProviderRoute | null> | undefined {
  return routes.size > 0 ? Object.fromEntries(routes) : undefined;
}
