export const IdentityRegistryAbi = [
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "URIUpdated",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "newURI", type: "string", indexed: false },
      { name: "updatedBy", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;
