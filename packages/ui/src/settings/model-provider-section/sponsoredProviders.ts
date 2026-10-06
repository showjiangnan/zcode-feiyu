export const SPONSORED_PROVIDER_SPECS = [
  {
    id: "teamorouter",
    nodeKey: "sponsored:teamorouter",
    label: "teamorouter",
    loginUrl: "https://teamorouter.com/?i=bab87d35f3",
  },
] as const;

export type SponsoredProviderId = (typeof SPONSORED_PROVIDER_SPECS)[number]["id"];
