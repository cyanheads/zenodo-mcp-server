/**
 * @fileoverview Server-specific configuration, parsed lazily from the environment.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  accessToken: z
    .string()
    .optional()
    .describe(
      'Zenodo personal access token (created with no scopes). Raises the global rate limit; tool behavior and page sizes are unchanged.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parsed server config. A blank or unsubstituted `${…}` token reads as unset. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, { accessToken: 'ZENODO_ACCESS_TOKEN' });
  return _config;
}
