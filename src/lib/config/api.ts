import type { AppConfig } from "$lib/types/map";
import { env } from "$env/dynamic/public";

export function createAppConfig(): AppConfig {
  return {
    gistApi: "https://api.github.com/gists/",
    relayHost: env.PUBLIC_RELAY_HOST ?? "https://relay.bitjita.com",
    exportsCdn: env.PUBLIC_EXPORTS_CDN ?? "https://exports.bitjita.com/bitcraftmap",
  };
}
